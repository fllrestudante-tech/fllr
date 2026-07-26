// Market Brain — primeiro dos 5 motores de decisão da plataforma. Responde
// só "o que o mercado está fazendo" (tendência/sentimento/risco), nunca
// decide trade nenhum (isso é papel do Risk Brain/Confidence Engine, ainda
// não construídos). Funções puras: recebem dado já lido (lib/brains/
// marketBrainData.js cuida do I/O), nunca tocam banco/rede.
//
// Contrato de saída (igual pra todo Brain futuro, ver arquitetura de 5
// Brains): { state, confidence: 0-100, reasons: string[], missingEvidence:
// string[] }. `reasons` existe pra que o Confidence/Learning Engine
// (ainda não construídos) consigam responder "por que o Market Brain
// concluiu isso" — sem isso nenhum aprendizado real é possível.
// `missingEvidence` documenta hoje quais fontes futuras ainda não
// alimentam cada eixo, pra auditoria (ex: "por que a confiança era 74%").
const { calcEMASeries } = require("../indicators");
const { createBrainResult } = require("./brainResult");

const MARKET_DEPENDS_ON = ["fear_greed", "btc_dominance", "funding", "open_interest", "long_short_ratio", "candles"];
// Reasons exatos usados pelos 3 eixos quando caem no fallback de "sem dado"
// -- ver classifyTrend/classifySentiment/classifyRisk abaixo. Reaproveitado
// só pra medir completude de dado (confidence do BrainResult), não muda
// nada do cálculo interno de cada eixo.
const NO_DATA_REASONS = ["dado histórico insuficiente", "dado de Fear & Greed indisponível", "dado de risco indisponível"];

const EMA_SHORT_PERIOD = 50;
const EMA_LONG_PERIOD = 200;
const MIN_CANDLES_FOR_TREND = 200;
const RANGING_THRESHOLD_PCT = 0.1; // espaçamento EMA50↔EMA200 menor que isso = sem separação clara

// Períodos fixos e clássicos (golden/death cross), deliberadamente
// diferentes do emaShort/emaLong autoajustado de signal.js/tuning.json --
// aqueles são pra timing de entrada, este eixo quer regime macro estável.
const TREND_MISSING_EVIDENCE = ["ADX", "Market Structure (BOS/CHOCH)", "Liquidity", "Volume Profile"];
const SENTIMENT_MISSING_EVIDENCE = ["Narrative Brain (Telegram/YouTube/X agregado)"];
const RISK_MISSING_EVIDENCE = ["Market Structure (Liquidity Sweep)", "Volume Profile", "Whale Alerts"];

/**
 * "Trend Evidence" -- hoje só EMA50/EMA200, desenhado pra crescer (ADX/
 * Market Structure/Liquidity/Volume Profile entram depois, documentados em
 * missingEvidence) sem quebrar a forma da saída. Amostra insuficiente
 * (< 200 candles contíguos) nunca vira um julgamento precoce -- mesmo
 * princípio de lib/volatilityRegime.js.
 */
function classifyTrend({ closes }) {
  if (!closes || closes.length < MIN_CANDLES_FOR_TREND) {
    return { state: "RANGING", confidence: 0, reasons: ["dado histórico insuficiente"], missingEvidence: TREND_MISSING_EVIDENCE };
  }

  const emaShortSeries = calcEMASeries(closes, EMA_SHORT_PERIOD);
  const emaLongSeries = calcEMASeries(closes, EMA_LONG_PERIOD);

  // Deadband: sem isso, uma série praticamente flat (ruído de ponto
  // flutuante entre EMA50/EMA200 na casa de 1e-14%) já classificava como
  // BULL/BEAR por sorte de sinal -- RANGING precisa significar "sem
  // separação clara", não só "os dois lados discordam".
  const stateAt = (i) => {
    const price = closes[i];
    const emaShort = emaShortSeries[i];
    const emaLong = emaLongSeries[i];
    const spread = emaLong !== 0 ? ((emaShort - emaLong) / emaLong) * 100 : 0;
    if (Math.abs(spread) < RANGING_THRESHOLD_PCT) return "RANGING";
    if (spread > 0 && price > emaLong) return "TRENDING_BULL";
    if (spread < 0 && price < emaLong) return "TRENDING_BEAR";
    return "RANGING";
  };

  const lastIndex = closes.length - 1;
  const state = stateAt(lastIndex);

  // Persistência: quantos candles seguidos (contando pra trás a partir do
  // mais recente) terminam no mesmo estado -- mesma ideia de "série pra
  // trás" de lib/volatilityRegime.js::classifyVolatilitySeries, aqui usada
  // só pra contar o streak, não pra guardar a série inteira.
  let persistence = 1;
  for (let i = lastIndex - 1; i >= MIN_CANDLES_FOR_TREND - 1; i--) {
    if (stateAt(i) !== state) break;
    persistence++;
  }

  const price = closes[lastIndex];
  const emaShort = emaShortSeries[lastIndex];
  const emaLong = emaLongSeries[lastIndex];
  const distancePricePct = ((price - emaLong) / emaLong) * 100;
  const spreadPct = ((emaShort - emaLong) / emaLong) * 100;

  const reasons = [];
  if (state === "TRENDING_BULL") reasons.push("EMA50 acima da EMA200");
  else if (state === "TRENDING_BEAR") reasons.push("EMA50 abaixo da EMA200");
  else reasons.push("EMA50 e EMA200 sem separação clara");
  reasons.push(`Distância EMA50↔EMA200: ${spreadPct.toFixed(1)}%`);
  reasons.push(price >= emaLong ? "Preço acima da EMA200" : "Preço abaixo da EMA200");
  reasons.push(`Tendência mantida há ${persistence} candles`);

  // Confiança: hipótese inicial (não validada por backtest ainda -- essa
  // infra, o Confidence Engine, só existe depois deste item no
  // sequenciamento), média simples de 3 pilares escalados 0-100.
  const distanceScore = Math.min(100, Math.abs(distancePricePct) * 20);
  const spreadScore = Math.min(100, Math.abs(spreadPct) * 20);
  const persistenceScore = Math.min(100, (persistence / 100) * 100);
  const confidence = Math.round((distanceScore + spreadScore + persistenceScore) / 3);

  return { state, confidence, reasons, missingEvidence: TREND_MISSING_EVIDENCE };
}

// Fear&Greed já vem classificado pela própria API (value_classification) --
// só mapeia pro vocabulário do Market Brain, não inventa uma classificação
// nova quando a fonte já dá uma boa.
const SENTIMENT_BUCKET_BY_CLASSIFICATION = {
  "extreme fear": "PANIC",
  fear: "PANIC",
  neutral: "NEUTRAL",
  greed: "EUPHORIA",
  "extreme greed": "EUPHORIA",
};

function bucketForClassification(classification) {
  return SENTIMENT_BUCKET_BY_CLASSIFICATION[(classification || "").toLowerCase()] || "NEUTRAL";
}

/**
 * `history`: linhas de fear_greed mais recente primeiro (index 0 = hoje).
 * Confiança = distância de 50 no value (0-100) -- quanto mais extremo,
 * mais confiança no rótulo, não fabrica uma escala nova.
 */
function classifySentiment({ history }) {
  if (!history || history.length === 0) {
    return { state: "NEUTRAL", confidence: 0, reasons: ["dado de Fear & Greed indisponível"], missingEvidence: SENTIMENT_MISSING_EVIDENCE };
  }

  const latest = history[0];
  const state = bucketForClassification(latest.classification);
  const confidence = Math.round((Math.abs(latest.value - 50) / 50) * 100);

  const reasons = [`Fear & Greed Index: ${latest.value} (${latest.classification})`];
  const sameBucketCount = history.filter((h) => bucketForClassification(h.classification) === state).length;
  if (history.length > 1 && sameBucketCount === history.length) {
    reasons.push(`Sentimento estável nos últimos ${history.length} dias`);
  }

  return { state, confidence, reasons, missingEvidence: SENTIMENT_MISSING_EVIDENCE };
}

function normalizeToUnitRange(value, scale) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  return Math.max(-1, Math.min(1, value / scale));
}

/**
 * RISK_ON/RISK_OFF -- hipótese explícita, pesos e escalas não validados por
 * backtest ainda (mesma disciplina já usada pros pesos do score de 100
 * pontos: ajustável quando houver dado real de impacto, não travado por
 * intuição). Combina só os pilares disponíveis (média ponderada
 * renormalizada pelo peso restante -- mesmo padrão de
 * lib/dataConfidenceScore.js), nunca fabrica um pilar ausente.
 */
function classifyRisk({ fundingRate, oiTrendPct, longShortSkew, dominanceTrendPct }) {
  const pillars = [];
  const reasons = [];

  if (typeof fundingRate === "number") {
    pillars.push({ score: normalizeToUnitRange(fundingRate, 0.0003), weight: 0.3 });
    reasons.push(fundingRate >= 0 ? `Funding positivo (${(fundingRate * 100).toFixed(4)}%)` : `Funding negativo (${(fundingRate * 100).toFixed(4)}%)`);
  }
  if (typeof oiTrendPct === "number") {
    pillars.push({ score: normalizeToUnitRange(oiTrendPct, 5), weight: 0.2 });
    reasons.push(oiTrendPct >= 0 ? `Open Interest subindo (+${oiTrendPct.toFixed(1)}%)` : `Open Interest caindo (${oiTrendPct.toFixed(1)}%)`);
  }
  if (typeof longShortSkew === "number") {
    pillars.push({ score: normalizeToUnitRange(longShortSkew, 0.2), weight: 0.2 });
    reasons.push(
      longShortSkew >= 0 ? `Maioria comprada (${(50 + longShortSkew * 100).toFixed(0)}% long)` : `Maioria vendida (${(50 - longShortSkew * 100).toFixed(0)}% short)`
    );
  }
  if (typeof dominanceTrendPct === "number") {
    pillars.push({ score: normalizeToUnitRange(-dominanceTrendPct, 2), weight: 0.3 });
    reasons.push(dominanceTrendPct <= 0 ? `Dominância BTC caindo (${dominanceTrendPct.toFixed(1)}%)` : `Dominância BTC subindo (+${dominanceTrendPct.toFixed(1)}%)`);
  }

  if (pillars.length === 0) {
    return { state: "RISK_OFF", confidence: 0, reasons: ["dado de risco indisponível"], missingEvidence: RISK_MISSING_EVIDENCE };
  }

  const totalWeight = pillars.reduce((sum, p) => sum + p.weight, 0);
  const weightedSum = pillars.reduce((sum, p) => sum + p.score * p.weight, 0);
  const overallScore = weightedSum / totalWeight;

  const state = overallScore >= 0 ? "RISK_ON" : "RISK_OFF";
  const confidence = Math.round(Math.abs(overallScore) * 100);

  return { state, confidence, reasons, missingEvidence: RISK_MISSING_EVIDENCE };
}

const OVERALL_DIRECTION = {
  trend: { TRENDING_BULL: 1, TRENDING_BEAR: -1, RANGING: 0 },
  // EUPHORIA/PANIC lidos "ao pé da letra" (euforia=favorável, pânico=
  // desfavorável), não de forma contrária -- é uma escolha discutível
  // (alguns traders comprariam pânico/venderiam euforia) e fica registrada
  // como suposição não validada, não como verdade estabelecida.
  sentiment: { EUPHORIA: 1, PANIC: -1, NEUTRAL: 0 },
  risk: { RISK_ON: 1, RISK_OFF: -1 },
};

/** Agrega os 3 eixos numa leitura direcional única -- ver módulo comment. */
function combineOverall({ trend, sentiment, risk }) {
  const axes = [
    { name: "Tendência", axis: trend, map: OVERALL_DIRECTION.trend },
    { name: "Sentimento", axis: sentiment, map: OVERALL_DIRECTION.sentiment },
    { name: "Risco", axis: risk, map: OVERALL_DIRECTION.risk },
  ];

  let weightedSum = 0;
  let totalWeight = 0;
  const reasons = [];
  const missingEvidence = [];

  for (const { name, axis, map } of axes) {
    const direction = map[axis.state] ?? 0;
    const weight = axis.confidence / 100;
    weightedSum += direction * weight;
    totalWeight += weight;
    if (axis.reasons.length > 0) reasons.push(`${name}: ${axis.reasons[0]}`);
    for (const eviction of axis.missingEvidence) if (!missingEvidence.includes(eviction)) missingEvidence.push(eviction);
  }

  const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const state = overallScore > 0.15 ? "MARKET_FAVORABLE" : overallScore < -0.15 ? "MARKET_UNFAVORABLE" : "MARKET_NEUTRAL";
  const confidence = Math.round((trend.confidence + sentiment.confidence + risk.confidence) / 3);

  return { state, confidence, reasons, missingEvidence };
}

// Completude de dado (distinto de confidence/score de cada eixo, que
// medem força/certeza do resultado, não se o dado existia) -- quantos dos
// 3 eixos tinham dado real, não caíram no fallback de "amostra
// insuficiente"/"indisponível". Vira o `confidence` do BrainResult.
function computeDataCompleteness({ trend, sentiment, risk }) {
  const axes = [trend, sentiment, risk];
  const withRealData = axes.filter((axis) => !(axis.reasons.length === 1 && NO_DATA_REASONS.includes(axis.reasons[0]))).length;
  return Math.round((withRealData / axes.length) * 100);
}

/**
 * Orquestra os 3 eixos + overall, embrulhados no BrainResult comum a todo
 * Brain (ver lib/brains/brainResult.js). `state`/`reasons`/`missingEvidence`
 * vêm do `overall` (mesma função combineOverall de sempre); `score` é a
 * força direcional ponderada que antes era `overall.confidence`;
 * `confidence` (novo, distinto) é completude de dado, não força do sinal.
 * `evidence` fica vazio -- Market Brain ainda não produz eventos tipados
 * como o Structure Brain, `reasons` já cobre isso textualmente.
 * `inputs` vem de marketBrainData.js::gatherMarketBrainInputs.
 */
function analyzeMarket({ closes, fearGreedHistory, fundingRate, oiTrendPct, longShortSkew, dominanceTrendPct }) {
  const startedAt = Date.now();
  const trend = classifyTrend({ closes });
  const sentiment = classifySentiment({ history: fearGreedHistory });
  const risk = classifyRisk({ fundingRate, oiTrendPct, longShortSkew, dominanceTrendPct });
  const overall = combineOverall({ trend, sentiment, risk });

  return createBrainResult({
    state: overall.state,
    confidence: computeDataCompleteness({ trend, sentiment, risk }),
    score: overall.confidence,
    reasons: overall.reasons,
    evidence: [],
    missingEvidence: overall.missingEvidence,
    sourceDataTime: fearGreedHistory && fearGreedHistory.length > 0 ? new Date(fearGreedHistory[0].snapshot_time).toISOString() : null,
    startedAt,
    dependsOn: MARKET_DEPENDS_ON,
    extra: { trend, sentiment, risk },
  });
}

module.exports = { classifyTrend, classifySentiment, classifyRisk, combineOverall, analyzeMarket };

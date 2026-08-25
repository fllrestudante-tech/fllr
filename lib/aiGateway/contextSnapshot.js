// Monta o snapshot estruturado de contexto entregue ao AI Gateway a cada
// ciclo em que lib/aiGateway/decisionCyclePolicy.js decide que vale a pena
// avaliar. Só usa dado já computado neste ciclo (analysis/regime/botState --
// gratuito, zero I/O extra) ou já persistido em disco pelo Runtime Metrics
// Engine (runtime/metrics/context.json e quality.json, ambos slow-tier/
// 15min, escritos por scripts/metricsSampler.js) -- NUNCA recalcula Brains
// nem abre o market.db a partir daqui. O loop de trading roda a cada 10s
// (config.loopIntervalMs); recomputar Structure/Liquidity/FVG a esse ritmo
// competiria por I/O com o coletor e atrasaria a checagem de SL/TP/trailing,
// que é sempre prioridade sobre qualquer leitura de IA.
const fs = require("fs");
const path = require("path");
const config = require("../../config");

const METRICS_DIR = path.join(__dirname, "..", "..", "runtime", "metrics");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findEvidencePayload(contextFusion, type) {
  const entry = (contextFusion?.evidence || []).find((e) => e.type === type);
  return entry ? entry.payload : null;
}

// =====================================================================
// Selecao do ultimo candle FECHADO -- Fase 10 / Commit 4c1. Usado so para
// ancorar a identidade da avaliacao do AgentRouter (agentRouterAssessmentKey.js),
// NUNCA para alterar o array usado por lib/signal.js::analyze() (que
// continua recebendo candles como sempre recebeu -- essa e uma decisao
// deliberada deste commit, ver auditoria/plano aprovado).
//
// lib/bybit.js::getKlines ja converte startTime via Number(c[0]) antes de
// devolver (confirmado por leitura direta do codigo: `.map((c) =>
// [Number(c[0]), ...])`) -- mesmo assim, NUNCA confiamos cegamente nisso
// aqui: validateCandleTimestampMs exige um `number` de verdade (nunca
// coage string->number, mesma rigidez do canonicalFiniteNumber usado no
// fingerprint quantitativo).
//
// Nunca usa indice fixo (penultimo/ultimo) como prova de fechamento --
// sempre calcula startTime + duracao <= now. Cobre: API atrasada (o
// "ultimo" elemento pode ja estar fechado), sem candle corrente no
// retorno, candles fora de ordem, dados insuficientes, intervalo
// desconhecido, candle mensal desalinhado.
//
// CORRECAO pos-4c1: estes helpers sao PUROS e NAO alimentam o retorno de
// buildContextSnapshot() -- hashContext() (lib/aiGateway/aiGateway.js)
// inclui TODAS as propriedades de `context` no hash de cada avaliacao;
// um campo de identidade do AgentRouter aqui mudaria esse hash e poderia
// vazar em logs/prompts, mesmo com AGENTROUTER_BUDGET_ENABLED=false. O
// wiring (Commit 4c2, fora de escopo) chamara selectLastClosedCandleTimestampMs()
// separadamente e colocara o resultado dentro de assessmentMeta, nunca
// dentro de `context`.
// =====================================================================

// Minutos: enum oficial de intervalos numericos da Bybit V5 kline (1,3,5,
// 15,30,60,120,240,360,720) + D (dia) e W (semana) -- todos com duracao
// FIXA em UTC (epoch ms puro, sem nenhuma dependencia de timezone local ou
// DST -- somar milissegundos a um instante UTC sempre atravessa
// corretamente fronteiras de mes/ano, por construcao). "M" (mes
// calendario) NAO tem duracao fixa -- tratado a parte em candleEndMs().
const INTERVAL_DURATION_MS = Object.freeze({
  "1": 60_000,
  "3": 3 * 60_000,
  "5": 5 * 60_000,
  "15": 15 * 60_000,
  "30": 30 * 60_000,
  "60": 60 * 60_000,
  "120": 120 * 60_000,
  "240": 240 * 60_000,
  "360": 360 * 60_000,
  "720": 720 * 60_000,
  D: 24 * 60 * 60_000,
  W: 7 * 24 * 60 * 60_000,
});

/**
 * SO aceita `number` (inteiro seguro, nao-negativo) -- NUNCA coage string
 * pra numero (mesma rigidez de canonicalFiniteNumber em
 * agentRouterAssessmentKey.js). lib/bybit.js ja entrega number; um valor
 * que chegue como string (ex.: concatenacao acidental com uma duracao em
 * algum ponto futuro do pipeline) e' REJEITADO, nunca interpretado.
 */
function validateCandleTimestampMs(rawValue) {
  return typeof rawValue === "number" && Number.isSafeInteger(rawValue) && rawValue >= 0 ? rawValue : null;
}

function isValidCandleTuple(candle) {
  // Estrutura minima: array com pelo menos o timestamp na posicao 0
  // (lib/bybit.js::getKlines sempre devolve exatamente 6 elementos, mas so
  // o timestamp interessa aqui).
  return Array.isArray(candle) && candle.length >= 1;
}

/**
 * Instante de fechamento de um candle, dado seu startTime (ja validado) e
 * o intervalo. "M" exige alinhamento real ao 1o dia do mes em UTC
 * 00:00:00.000 (jeito como a Bybit alinha candles mensais) -- um candle
 * mensal desalinhado falha fechado (null) em vez de calcular "o mesmo dia
 * do mes seguinte" genericamente, que seria errado pra candles que nao
 * comecam no dia 1. D/W tem duracao FIXA em UTC (24h/7*24h) -- soma pura
 * de epoch ms, correta por construcao em qualquer fronteira de mes/ano.
 * Intervalo desconhecido -> null, nunca adivinha.
 */
function candleEndMs(startTimeMs, interval) {
  const safeStart = validateCandleTimestampMs(startTimeMs);
  if (safeStart === null) return null;

  if (interval === "M") {
    const d = new Date(safeStart);
    const isAlignedToMonthStartUtc =
      d.getUTCDate() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    if (!isAlignedToMonthStartUtc) return null; // candle mensal desalinhado -- fail closed
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
    return Number.isSafeInteger(end) ? end : null;
  }

  const durationMs = INTERVAL_DURATION_MS[interval];
  if (durationMs === undefined) return null; // intervalo desconhecido
  const end = safeStart + durationMs;
  return Number.isSafeInteger(end) ? end : null;
}

/**
 * Varre `candles` de tras pra frente ate achar um candle GENUINAMENTE
 * fechado (startTime + duracao <= nowMs) -- nunca assume posicao fixa.
 *
 * Validacao ESTRUTURAL de toda a serie ANTES de qualquer selecao: se
 * qualquer candle tiver estrutura invalida, timestamp invalido, ou a serie
 * estiver fora de ordem (nao estritamente crescente -- inclui duplicatas),
 * a serie INTEIRA e' considerada nao confiavel e a funcao devolve `null`
 * -- nunca "pula" o candle ruim e segue como se nada tivesse acontecido.
 *
 * nowMs tambem e' validado (inteiro seguro nao-negativo); invalido -> null.
 * Nunca muta `candles` nem os candles individuais.
 */
function selectLastClosedCandle(candles, interval, nowMs) {
  const safeNowMs = validateCandleTimestampMs(nowMs);
  if (safeNowMs === null) return null;
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const timestamps = [];
  for (const candle of candles) {
    if (!isValidCandleTuple(candle)) return null;
    const ts = validateCandleTimestampMs(candle[0]);
    if (ts === null) return null;
    timestamps.push(ts);
  }

  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] <= timestamps[i - 1]) return null; // duplicado ou fora de ordem -- fail closed
  }

  for (let i = candles.length - 1; i >= 0; i--) {
    const end = candleEndMs(timestamps[i], interval);
    if (end !== null && end <= safeNowMs) return candles[i];
  }
  return null; // nenhum candle fechado encontrado (dados atrasados/insuficientes)
}

/**
 * Conveniencia para o futuro wiring do Commit 4c2: mesma logica de
 * selectLastClosedCandle, mas ja devolve so o timestamp (ou null). O
 * chamador (index.js, fora do escopo deste commit) passara esse valor
 * dentro de assessmentMeta -- NUNCA dentro de `context` (ver correcao
 * aprovada: identidade do AgentRouter e' metadata local, separada do
 * contexto enviado a providers/prompt).
 */
function selectLastClosedCandleTimestampMs(candles, interval, nowMs) {
  const candle = selectLastClosedCandle(candles, interval, nowMs);
  return candle ? candle[0] : null;
}

function buildRiskState({ botState, regime, now = Date.now() }) {
  const circuitBreakerActive = !!(botState.circuitBreakerUntil && now < botState.circuitBreakerUntil);
  return {
    volatilityRegime: regime,
    circuitBreakerActive,
    circuitBreakerRemainingMs: circuitBreakerActive ? botState.circuitBreakerUntil - now : 0,
    consecutiveLosses: botState.consecutiveLosses || 0,
    consecutiveLossesLimit: config.circuitBreakerLossStreak,
    dailyLossPct: botState.dailyLoss || 0,
    dailyLossLimitPct: config.dailyLossLimitPct,
  };
}

function buildPositionSnapshot(botState) {
  if (!botState.isOpened) return { isOpened: false };
  return {
    isOpened: true,
    side: botState.side,
    entryPrice: botState.entryPrice,
    qty: botState.qty,
    stopLossPrice: botState.stopLossPrice,
    takeProfitPrice: botState.takeProfitPrice,
    breakEvenApplied: !!botState.breakEvenApplied,
    trailingActivated: !!botState.trailingActivated,
    tpLevelsTotal: (botState.tpLevels || []).length,
    tpLevelsFilled: botState.tpLevelsFilled || 0,
    holdMs: botState.openedAt ? Date.now() - botState.openedAt : null,
  };
}

function buildQuantSignal(analysis) {
  return {
    signal: analysis.signal,
    reasons: analysis.reasons,
    price: analysis.price,
    indicators: {
      emaShort: analysis.ema8,
      emaLong: analysis.ema56,
      rsi: analysis.rsi,
      stochRsi: analysis.stoch,
      obv: analysis.obv,
      atr: analysis.atr,
    },
    params: analysis.params,
  };
}

/**
 * market/structure/liquidity aqui são só {state, score, confidence} (o que
 * o Context Fusion persiste em evidence[].payload) -- mais enxuto que os
 * BrainResult completos que lib/shadowEvaluation.js recomputa direto do
 * market.db (aqueles têm `reasons`; este não). Tradeoff deliberado: o loop
 * de trading paga zero custo de I/O/CPU extra por isso, e
 * lib/aiGateway/promptBuilder.js já tolera a ausência de `reasons`.
 */
// contextFusion/quality são injetáveis (testabilidade, mesmo padrão de
// lib/backtest.js::run({db, bybitClient})) -- por padrão lê os snapshots
// reais do Runtime Metrics Engine.
function buildContextSnapshot({ analysis, regime, botState, now = Date.now(), contextFusion, quality } = {}) {
  if (contextFusion === undefined) contextFusion = readJsonSafe(path.join(METRICS_DIR, "context.json"));
  if (quality === undefined) quality = readJsonSafe(path.join(METRICS_DIR, "quality.json"));

  return {
    symbol: config.symbol,
    interval: config.interval,
    price: analysis.price,
    quant: buildQuantSignal(analysis),
    position: buildPositionSnapshot(botState),
    riskState: buildRiskState({ botState, regime, now }),
    market: findEvidencePayload(contextFusion, "MARKET_BRAIN"),
    structure: findEvidencePayload(contextFusion, "STRUCTURE_BRAIN"),
    liquidity: findEvidencePayload(contextFusion, "LIQUIDITY_BRAIN"),
    fusion: contextFusion
      ? {
          state: contextFusion.state,
          confidence: contextFusion.confidence,
          score: contextFusion.score,
          reasons: contextFusion.reasons,
          dominantNarrative: contextFusion.dominantNarrative,
          secondaryNarrative: contextFusion.secondaryNarrative,
        }
      : null,
    marketQuality: quality?.quality || null,
    crossSourceValidation: quality?.crossSourceValidation || null,
    sourceReliability: quality?.sourceReliability || null,
    contextFusionSampledAt: contextFusion?.sampledAt || null,
    qualitySampledAt: quality?.sampledAt || null,
    snapshotAt: new Date(now).toISOString(),
  };
}

module.exports = {
  buildContextSnapshot,
  buildRiskState,
  buildPositionSnapshot,
  buildQuantSignal,
  readJsonSafe,
  findEvidencePayload,
  selectLastClosedCandle,
  selectLastClosedCandleTimestampMs,
  candleEndMs,
  validateCandleTimestampMs,
  INTERVAL_DURATION_MS,
};

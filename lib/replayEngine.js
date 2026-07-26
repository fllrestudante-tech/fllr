// Replay Engine — não é um gerador de dataset, é o JUIZ dos próprios
// Brains. Anda pelo histórico de candles em passos, roda a cadeia inteira
// de Brains (mesma ordem de dependência de sempre: Market -> Structure ->
// Liquidity -> Context Fusion -> FVG -> Order Block -> Institutional
// Context), grava um snapshot enxuto, espera `outcomeHorizonCandles` pra
// medir o que o preço fez de verdade e atribui um veredito contra a
// direção que o Context Fusion já tinha fundido. `computeStats` responde
// "essa combinação de estados acerta quanto?" e `computeTransitions`
// devolve a sequência de mudanças de estado de um Brain (Bull -> Weak ->
// Broken -> Recovery), sem duplicar a mesma leitura repetida snapshot a
// snapshot.
//
// Restrição documentada (não é hack): os eixos sentimento/risco do
// Market Brain sempre leem "o dado mais recente agora"
// (lib/brains/marketBrainData.js -- sem filtro de tempo). Replayar isso
// vazaria dado do FUTURO pra dentro de um snapshot antigo (look-ahead
// bias). Por isso aqui `analyzeMarket` recebe só `closes` -- os outros
// campos vão null/[]/vazio, que é literalmente o caminho de "dado
// indisponível" que lib/brains/marketBrain.js já trata sozinho. Corrigir
// isso de verdade exigiria consultas "asOf(cutoffTime)" nas 5 tabelas
// (Fear&Greed/funding/OI/long-short/dominância), documentado como
// próximo passo, não construído agora.
//
// Puro sobre um array de candles já carregado -- não abre banco, não
// escreve arquivo (isso é papel de scripts/replayEngine.js).
// Puramente observacional -- index.js::cycle() não depende disto.
const { analyzeMarket } = require("./brains/marketBrain");
const { analyzeStructure } = require("./brains/structureBrain");
const { analyzeLiquidity } = require("./brains/liquidityBrain");
const { fuseContext, directionFromMarket, directionFromStructure, directionFromLiquidity } = require("./brains/contextFusion");
const { analyzeFVG } = require("./brains/fvgBrain");
const { analyzeOrderBlocks } = require("./brains/orderBlockBrain");
const { synthesizeInstitutionalContext } = require("./brains/institutionalContext");

const EVIDENCE_SOURCES = [
  { brain: "structure", key: "structure" },
  { brain: "liquidity", key: "liquidity" },
  { brain: "fvg", key: "fvg" },
  { brain: "orderBlock", key: "orderBlock" },
];

const DIRECTION_FROM_CONTEXT_STATE = { FUSED_BULLISH: "bull", FUSED_BEARISH: "bear", FUSED_NEUTRAL: null };

function directionFromZoneShape(direction) {
  if (direction === "bullish") return "bull";
  if (direction === "bearish") return "bear";
  return null;
}

/**
 * Direção (bull/bear/null) de cada Brain individual -- pra medir acurácia
 * POR Brain (lib/brainAnalytics.js), não só a direção já fundida do
 * Context Fusion. Reaproveita as 3 extrações genéricas de
 * contextFusion.js; FVG/Order Block/Institutional Context guardam a
 * direção no bloco/gap/zona dominante (formato "bullish"/"bearish", não
 * "bull"/"bear" -- por isso o mapeamento).
 */
function directionForBrain(brainKey, brains) {
  switch (brainKey) {
    case "market":
      return directionFromMarket(brains.market);
    case "structure":
      return directionFromStructure(brains.structure);
    case "liquidity":
      return directionFromLiquidity(brains.liquidity);
    case "context":
      return DIRECTION_FROM_CONTEXT_STATE[brains.context.state] ?? null;
    case "fvg":
      return directionFromZoneShape(brains.fvg.imbalanceDirection);
    case "orderBlock":
      return directionFromZoneShape(brains.orderBlock.dominantBlock?.direction ?? null);
    case "institutional":
      return directionFromZoneShape(brains.institutional.dominantZone?.direction ?? null);
    default:
      return null;
  }
}

function pickSummary(brain, direction) {
  return { state: brain.state, confidence: brain.confidence, score: brain.score, direction };
}

/**
 * Evidência nova desde o último snapshot -- janelas de replay se
 * sobrepõem quase inteiras entre passos consecutivos, sem esse filtro o
 * mesmo BOS/sweep/gap/bloco antigo apareceria repetido em dezenas de
 * snapshots seguidos.
 */
function extractNewEvents(brains, lastSnapshotTime) {
  const events = [];
  for (const { brain, key } of EVIDENCE_SOURCES) {
    for (const e of brains[key].evidence || []) {
      const eventTime = new Date(e.timestamp).getTime();
      if (eventTime > lastSnapshotTime) events.push({ brain, type: e.type, timestamp: e.timestamp });
    }
  }
  return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

/**
 * Núcleo da comparação direção-apostada vs. retorno real -- reaproveitado
 * tanto por `gradeOutcome` (grade contra o Context) quanto por
 * lib/brainAnalytics.js (grade por Brain individual), pra não duplicar o
 * mesmo threshold em dois lugares.
 */
function classifyDirectionalOutcome(direction, forwardReturnPct, thresholdPct) {
  if (!direction) return "NOT_GRADED";
  const favorable = direction === "bull" ? forwardReturnPct : -forwardReturnPct;
  if (favorable > thresholdPct) return "SUCCESS";
  if (favorable < -thresholdPct) return "FAIL";
  return "INCONCLUSIVE";
}

/**
 * Pior excursão contra a direção apostada entre o candle do snapshot e o
 * horizonte de saída (usa high/low reais, não só o close final) -- um
 * número por snapshot, não uma curva de equity completa (documentado
 * como simplificação, não fabricação de precisão que não existe).
 */
function computeMaxAdverseExcursionPct(candles, i, forwardIndex, direction, entryPrice) {
  let worst = 0;
  for (let j = i + 1; j <= forwardIndex; j++) {
    const high = parseFloat(candles[j][2]);
    const low = parseFloat(candles[j][3]);
    const adverseExtreme = direction === "bull" ? low : high;
    const adversePct = direction === "bull" ? ((adverseExtreme - entryPrice) / entryPrice) * 100 : ((entryPrice - adverseExtreme) / entryPrice) * 100;
    worst = Math.min(worst, adversePct);
  }
  return Math.abs(worst);
}

/**
 * Veredito contra a direção que o Context Fusion já fundiu -- não
 * recalcula direção aqui, reaproveita. PENDING quando não há candles
 * futuros suficientes ainda (replay não fabrica o que ainda não
 * aconteceu); NOT_GRADED quando o contexto era neutro (nenhuma direção
 * foi de fato "apostada"); INCONCLUSIVE dentro do threshold (hipótese,
 * calibrável, é exatamente o tipo de número que este motor existe pra
 * validar no futuro).
 */
function gradeOutcome(candles, i, outcomeHorizonCandles, outcomeThresholdPct, contextState) {
  const forwardIndex = i + outcomeHorizonCandles;
  if (forwardIndex >= candles.length) return { outcome: "PENDING", forwardReturnPct: null, maxAdverseExcursionPct: null };

  const currentClose = parseFloat(candles[i][4]);
  const futureClose = parseFloat(candles[forwardIndex][4]);
  const forwardReturnPct = ((futureClose - currentClose) / currentClose) * 100;

  const direction = DIRECTION_FROM_CONTEXT_STATE[contextState];
  const outcome = classifyDirectionalOutcome(direction, forwardReturnPct, outcomeThresholdPct);
  if (outcome === "NOT_GRADED") return { outcome, forwardReturnPct, maxAdverseExcursionPct: null };

  const maxAdverseExcursionPct = computeMaxAdverseExcursionPct(candles, i, forwardIndex, direction, currentClose);
  return { outcome, forwardReturnPct, maxAdverseExcursionPct };
}

function runReplay(candles, options) {
  const {
    stepCandles,
    windowCandles,
    outcomeHorizonCandles,
    outcomeThresholdPct,
    structureLookback,
    equalTolerancePct,
    sweepReversalLookahead,
    exhaustionLookback,
    confirmAge,
    mitigationThreshold,
  } = options;

  const snapshots = [];
  let lastSnapshotTime = -Infinity;

  for (let i = windowCandles - 1; i < candles.length; i += stepCandles) {
    const windowSlice = candles.slice(i - windowCandles + 1, i + 1);

    const market = analyzeMarket({
      closes: windowSlice.map((c) => c[4]),
      fearGreedHistory: [],
      fundingRate: null,
      oiTrendPct: null,
      longShortSkew: null,
      dominanceTrendPct: null,
    });
    const structure = analyzeStructure({ candles: windowSlice, lookback: structureLookback });
    const liquidity = analyzeLiquidity({ candles: windowSlice, lookback: structureLookback, equalTolerancePct, sweepReversalLookahead });
    const context = fuseContext({ market, structure, liquidity });
    const fvg = analyzeFVG({ candles: windowSlice, structure, liquidity, context, exhaustionLookback });
    const orderBlock = analyzeOrderBlocks({ candles: windowSlice, structure, liquidity, context, confirmAge, mitigationThreshold, exhaustionLookback });
    const institutional = synthesizeInstitutionalContext({ liquidity, fvg, orderBlock });

    const timestamp = windowSlice[windowSlice.length - 1][0];
    const price = parseFloat(windowSlice[windowSlice.length - 1][4]);

    const newEvents = extractNewEvents({ structure, liquidity, fvg, orderBlock }, lastSnapshotTime);
    lastSnapshotTime = timestamp;

    const { outcome, forwardReturnPct, maxAdverseExcursionPct } = gradeOutcome(candles, i, outcomeHorizonCandles, outcomeThresholdPct, context.state);

    const brains = { market, structure, liquidity, context, fvg, orderBlock, institutional };
    const brainSummaries = {};
    for (const key of Object.keys(brains)) brainSummaries[key] = pickSummary(brains[key], directionForBrain(key, brains));

    snapshots.push({
      timestamp,
      price,
      brains: brainSummaries,
      newEvents,
      outcome,
      forwardReturnPct,
      maxAdverseExcursionPct,
    });
  }

  return snapshots;
}

const GRADED_OUTCOMES = ["SUCCESS", "FAIL", "INCONCLUSIVE"];

// Rótulo qualitativo de confiança pela contagem de ocorrências -- hipótese/
// heurística documentada, não estatística formal (ex: intervalo de
// confiança de verdade), serve só pra dar uma leitura rápida no dashboard.
const CONFIDENCE_LABEL_THRESHOLDS = [
  { min: 500, label: "Alta" },
  { min: 100, label: "Média" },
  { min: 0, label: "Baixa" },
];
function confidenceLabelFor(count) {
  return CONFIDENCE_LABEL_THRESHOLDS.find((t) => count >= t.min).label;
}

/**
 * "Essa combinação de estados acerta quanto?" -- agrupa só os snapshots já
 * julgados (exclui PENDING/NOT_GRADED, não dá pra tirar taxa de acerto de
 * quem não tinha direção nenhuma) pela combinação real dos states dos
 * Brains pedidos. successRate conta INCONCLUSIVE contra (denominador é o
 * grupo inteiro) -- escolha documentada, não a única possível.
 * avgDrawdownPct/confidenceLabel completam o formato pedido pelo usuário
 * (histórico/taxa de sucesso/drawdown/confiança por combinação).
 */
function computeStats(snapshots, brainKeys) {
  const graded = snapshots.filter((s) => GRADED_OUTCOMES.includes(s.outcome));

  const groups = new Map();
  for (const s of graded) {
    const comboKey = brainKeys.map((k) => `${k}:${s.brains[k].state}`).join("|");
    if (!groups.has(comboKey)) groups.set(comboKey, []);
    groups.get(comboKey).push(s);
  }

  const rows = [];
  for (const [comboKey, group] of groups) {
    const successCount = group.filter((s) => s.outcome === "SUCCESS").length;
    const avgForwardReturnPct = group.reduce((sum, s) => sum + s.forwardReturnPct, 0) / group.length;
    const avgDrawdownPct = group.reduce((sum, s) => sum + (s.maxAdverseExcursionPct || 0), 0) / group.length;
    rows.push({
      comboKey,
      count: group.length,
      successRate: Math.round((successCount / group.length) * 100),
      avgForwardReturnPct: Number(avgForwardReturnPct.toFixed(3)),
      avgDrawdownPct: Number(avgDrawdownPct.toFixed(3)),
      confidenceLabel: confidenceLabelFor(group.length),
    });
  }

  return rows.sort((a, b) => b.count - a.count);
}

/**
 * Só as MUDANÇAS de estado de um Brain, em ordem cronológica -- colapsa
 * repetições consecutivas (produz "Bull -> Weak -> Broken -> Recovery",
 * não a mesma leitura duplicada em toda linha).
 */
function computeTransitions(snapshots, brainKey) {
  const transitions = [];
  let lastState = null;
  for (const s of snapshots) {
    const state = s.brains[brainKey].state;
    if (state !== lastState) {
      transitions.push({ state, timestamp: s.timestamp });
      lastState = state;
    }
  }
  return transitions;
}

module.exports = { runReplay, gradeOutcome, extractNewEvents, computeStats, computeTransitions, classifyDirectionalOutcome, directionForBrain };

// Structure Brain — responde "a estrutura de mercado está saudável ou
// virando". v1: só swings + BOS/CHOCH (Equal Highs/Lows, Liquidity Sweep,
// FVG, Order Blocks ficam pro próximo incremento, listados em
// missingEvidence). Puramente observacional -- não decide trade nenhum,
// index.js::cycle() não depende disto ainda.
//
// Próxima evolução prevista (documentado, deliberadamente não implementada
// nesta versão): Swing Graph (nodes/edges) substituindo o cálculo direto
// de lib/marketStructure/structureEvidence.js caso surjam consumidores
// reais que precisem consultar a mesma estrutura de formas muito
// diferentes; Liquidity Engine (Equal Highs/Lows, Sweep); Order
// Blocks/Breaker/Mitigation; e um Decision Engine consumindo múltiplos
// BrainResults (deste + Market Brain + futuros) — hoje cada Brain só
// devolve sua própria leitura isolada, sem camada agregadora.
const { extractStructureEvidence } = require("../marketStructure/structureEvidence");
const { computeTrailingStreak } = require("../marketStructure/swingDetector");
const { createBrainResult } = require("./brainResult");

const MIN_CANDLES_FOR_STRUCTURE = 200;
const RECENT_EVENTS_WINDOW = 5;

const MISSING_EVIDENCE = ["Equal Highs/Lows", "Liquidity Sweep", "Fair Value Gap (FVG)", "Order Blocks", "Breaker Blocks", "Mitigation Blocks"];

function findLastByLabel(classifiedSwings, label) {
  for (let i = classifiedSwings.length - 1; i >= 0; i--) {
    if (classifiedSwings[i].label === label) return classifiedSwings[i];
  }
  return null;
}

// Score: força intrínseca do que foi encontrado -- streak de HH/HL (ou
// LH/LL) nos casos BOS ("quão consistente é a continuação"); magnitude %
// do rompimento nos casos CHOCH ("quão forte foi a quebra", não a força de
// uma estrutura que já não existe mais). Heurística documentada como
// hipótese, sem backtest ainda (mesma disciplina de sempre).
function computeScore({ lastEvent, bias, swingHighs, swingLows, candles }) {
  if (!lastEvent) return 0;
  if (lastEvent.type === "BOS") {
    const highLabel = bias === "bullish" ? "HH" : "LH";
    const lowLabel = bias === "bullish" ? "HL" : "LL";
    const streakSum = computeTrailingStreak(swingHighs, highLabel) + computeTrailingStreak(swingLows, lowLabel);
    return Math.min(100, streakSum * 12);
  }
  const closePrice = parseFloat(candles[lastEvent.index][4]);
  const magnitudePct = (Math.abs(closePrice - lastEvent.level) / lastEvent.level) * 100;
  return Math.round(Math.min(100, magnitudePct * 20));
}

// Confidence: 4 pilares 30/30/20/20 (pedido explícito -- não é só
// contagem de swings). Qualidade do dado + quantidade de evidência +
// consistência temporal (últimos N eventos, % que são BOS em vez de
// CHOCH) + consenso interno (streak de highs concorda com streak de
// lows). Só consenso DENTRO do Structure Brain -- consenso cross-brain
// (com volume/OI/funding do Market Brain) exigiria os Brains lerem uns
// aos outros, arquitetura que não existe ainda (fora de escopo desta
// entrega, ver comentário de topo).
function computeConfidence({ candles, swingHighs, swingLows, bias, recentEvents, chochCountRecent }) {
  const dataQualityScore = Math.min(100, (candles.length / MIN_CANDLES_FOR_STRUCTURE) * 100);
  const evidenceQuantityScore = Math.min(100, (swingHighs.length + swingLows.length) * 5);

  const bosRatio = recentEvents.length > 0 ? (recentEvents.length - chochCountRecent) / recentEvents.length : 1;
  const temporalConsistencyScore = Math.round(bosRatio * 100);

  const highStreak = bias === "bullish" ? computeTrailingStreak(swingHighs, "HH") : bias === "bearish" ? computeTrailingStreak(swingHighs, "LH") : 0;
  const lowStreak = bias === "bullish" ? computeTrailingStreak(swingLows, "HL") : bias === "bearish" ? computeTrailingStreak(swingLows, "LL") : 0;
  const consensusScore = highStreak > 0 && lowStreak > 0 ? 100 : highStreak > 0 || lowStreak > 0 ? 50 : 0;

  return Math.round(dataQualityScore * 0.3 + evidenceQuantityScore * 0.3 + temporalConsistencyScore * 0.2 + consensusScore * 0.2);
}

function classifyState({ bias, chochCountRecent, lastEvent, score }) {
  if (!bias) return "NEUTRAL";
  if (chochCountRecent >= 2) return "BROKEN";
  if (lastEvent && lastEvent.type === "CHOCH") return "WEAK";
  if (score >= 70) return "EXCELLENT";
  if (score >= 40) return "GOOD";
  return "NEUTRAL";
}

function computePersistence({ candles, events, swingHighs, swingLows }) {
  const lastChoch = [...events].reverse().find((e) => e.type === "CHOCH");
  if (lastChoch) return candles.length - 1 - lastChoch.index;
  const firstSwingIndex = Math.min(swingHighs.length > 0 ? swingHighs[0].index : Infinity, swingLows.length > 0 ? swingLows[0].index : Infinity);
  return firstSwingIndex === Infinity ? 0 : candles.length - 1 - firstSwingIndex;
}

function buildReasons({ lastEvent, bias, persistence }) {
  const reasons = [];
  if (lastEvent) {
    const directionLabel = lastEvent.direction === "bullish" ? "de alta" : "de baixa";
    const brokenLabel = lastEvent.brokenSwing.label || lastEvent.brokenSwing.type;
    reasons.push(`${lastEvent.type} ${directionLabel} confirmado (rompeu ${brokenLabel} em ${lastEvent.level.toFixed(2)})`);
  } else if (bias) {
    reasons.push(`Bias ${bias === "bullish" ? "de alta" : "de baixa"} estabelecido, aguardando rompimento`);
  } else {
    reasons.push("Sem bias de estrutura estabelecido ainda");
  }
  return reasons;
}

function buildTypedEvidence(events, { swingHighs, swingLows, candles }) {
  return events.map((e) => {
    const priorSwingCount = swingHighs.filter((s) => s.index <= e.index).length + swingLows.filter((s) => s.index <= e.index).length;
    const closePrice = parseFloat(candles[e.index][4]);
    const magnitudePct = (Math.abs(closePrice - e.level) / e.level) * 100;
    return {
      type: e.type,
      confidence: Math.round(Math.min(100, magnitudePct * 20)),
      weight: priorSwingCount,
      timestamp: new Date(candles[e.index][0]).toISOString(),
      payload: { level: e.level, brokenSwing: e.brokenSwing, direction: e.direction, candleIndex: e.index },
    };
  });
}

function insufficientDataResult(candles, startedAt) {
  return createBrainResult({
    state: "NEUTRAL",
    confidence: 0,
    score: 0,
    reasons: ["dado histórico insuficiente"],
    evidence: [],
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles && candles.length > 0 ? candles[candles.length - 1][0] : null,
    startedAt,
    dependsOn: ["candles"],
    extra: {
      swings: { highs: [], lows: [], lastHH: null, lastHL: null, lastLH: null, lastLL: null },
      trend: { bias: null, quality: "NEUTRAL", persistence: 0 },
      liquidity: { state: null, confidence: null },
      supportResistance: { nearestSupport: null, nearestResistance: null },
    },
  });
}

function analyzeStructure({ candles, lookback }) {
  const startedAt = Date.now();
  if (!candles || candles.length < MIN_CANDLES_FOR_STRUCTURE) return insufficientDataResult(candles, startedAt);

  const { swingHighs, swingLows, events, bias } = extractStructureEvidence(candles, { lookback });
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const recentEvents = events.slice(-RECENT_EVENTS_WINDOW);
  const chochCountRecent = recentEvents.filter((e) => e.type === "CHOCH").length;

  const score = computeScore({ lastEvent, bias, swingHighs, swingLows, candles });
  const confidence = computeConfidence({ candles, swingHighs, swingLows, bias, recentEvents, chochCountRecent });
  const state = classifyState({ bias, chochCountRecent, lastEvent, score });
  const persistence = computePersistence({ candles, events, swingHighs, swingLows });

  const reasons = buildReasons({ lastEvent, bias, persistence });
  if (bias) {
    const hLabel = bias === "bullish" ? "HH" : "LH";
    const lLabel = bias === "bullish" ? "HL" : "LL";
    reasons.push(`${computeTrailingStreak(swingHighs, hLabel)} ${hLabel} consecutivos, ${computeTrailingStreak(swingLows, lLabel)} ${lLabel} consecutivos`);
  }
  reasons.push(`Estrutura atual há ${persistence} candles`);

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence: buildTypedEvidence(events, { swingHighs, swingLows, candles }),
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles[candles.length - 1][0],
    startedAt,
    dependsOn: ["candles"],
    extra: {
      swings: {
        highs: swingHighs,
        lows: swingLows,
        lastHH: findLastByLabel(swingHighs, "HH"),
        lastLH: findLastByLabel(swingHighs, "LH"),
        lastHL: findLastByLabel(swingLows, "HL"),
        lastLL: findLastByLabel(swingLows, "LL"),
      },
      trend: { bias, quality: state, persistence },
      liquidity: { state: null, confidence: null },
      supportResistance: { nearestSupport: null, nearestResistance: null },
    },
  });
}

module.exports = { analyzeStructure, computeScore, computeConfidence, classifyState, computePersistence };

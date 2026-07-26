// FVG Brain — responde "qual é o estado dos desequilíbrios do mercado",
// não "achei um gap". Diferença central pedida pelo usuário: nasce
// CONTEXTUAL -- recebe Structure Brain + Liquidity Brain + Context Fusion
// como entrada e julga a qualidade/prioridade de cada gap comparando a
// direção dele com o contexto vigente (gap a favor = alta qualidade, gap
// contra = baixa prioridade). Primeiro Brain (além do próprio Context
// Fusion) que depende de outros Brains, não só de candles -- por isso
// `metadata.dependsOn` inclui nomes de Brain.
//
// Puramente observacional -- index.js::cycle() não depende disto.
//
// Próxima evolução prevista (documentado, não implementada nesta versão):
// Order Block Brain (mesma disciplina -- contextual, não detector
// isolado) e Institutional Context (síntese de Liquidity+FVG+Order
// Blocks, não é um Brain novo por si só) são os próximos itens da
// sequência.
const { detectFVGs, trackFillState } = require("../marketStructure/fvg");
const { directionFromStructure, directionFromLiquidity } = require("./contextFusion");
const { createBrainResult } = require("./brainResult");

const MIN_CANDLES_FOR_FVG = 200;

const MISSING_EVIDENCE = ["Order Blocks", "Institutional Context (Liquidity+FVG+Order Blocks)"];

const FILL_STATE_CONFIDENCE = { ACTIVE: 100, REBALANCING: 70, FILLED: 40, EXHAUSTED: 10 };

function directionFromContext(context) {
  if (context.state === "FUSED_BULLISH") return "bull";
  if (context.state === "FUSED_BEARISH") return "bear";
  return null;
}

function classifyGapFillState(gap, candles, exhaustionLookback) {
  const { touched, filled, filledAtIndex } = trackFillState(gap, candles);
  if (!touched) return "ACTIVE";
  if (!filled) return "REBALANCING";
  const candlesSinceFill = candles.length - 1 - filledAtIndex;
  return candlesSinceFill > exhaustionLookback ? "EXHAUSTED" : "FILLED";
}

/**
 * Conta quantos dos 3 Brains de contexto (Structure/Liquidity/Context
 * Fusion) concordam vs discordam da direção do gap -- hipótese
 * documentada, não validada por backtest (mesma disciplina de sempre).
 */
function computeAlignment(gapDirection, { structure, liquidity, context }) {
  const gapDir = gapDirection === "bullish" ? "bull" : "bear";
  const dirs = [directionFromStructure(structure), directionFromLiquidity(liquidity), directionFromContext(context)];
  return {
    agreeing: dirs.filter((d) => d === gapDir).length,
    opposing: dirs.filter((d) => d && d !== gapDir).length,
    totalWithDirection: dirs.filter(Boolean).length,
  };
}

function scoreFromAlignment({ agreeing, opposing }) {
  return Math.max(0, Math.min(100, 50 + (agreeing - opposing) * 20));
}

function distanceToPrice(gap, currentPrice) {
  if (currentPrice >= gap.low && currentPrice <= gap.high) return 0;
  return Math.min(Math.abs(currentPrice - gap.low), Math.abs(currentPrice - gap.high));
}

function insufficientDataResult(candles, startedAt) {
  return createBrainResult({
    state: "EMPTY",
    confidence: 0,
    score: 0,
    reasons: ["dado histórico insuficiente"],
    evidence: [],
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles && candles.length > 0 ? candles[candles.length - 1][0] : null,
    startedAt,
    dependsOn: ["candles", "structure_brain", "liquidity_brain", "context_fusion"],
    extra: { gaps: [], activeGaps: [], filledGaps: [], stackedGaps: [], nearestGap: null, imbalanceDirection: null },
  });
}

function analyzeFVG({ candles, structure, liquidity, context, exhaustionLookback }) {
  const startedAt = Date.now();
  if (!candles || candles.length < MIN_CANDLES_FOR_FVG) return insufficientDataResult(candles, startedAt);

  const gaps = detectFVGs(candles).map((g) => ({
    ...g,
    fillState: classifyGapFillState(g, candles, exhaustionLookback),
    alignment: computeAlignment(g.direction, { structure, liquidity, context }),
  }));

  const filledGaps = gaps.filter((g) => g.fillState === "FILLED" || g.fillState === "EXHAUSTED");
  const activeGaps = gaps.filter((g) => g.fillState === "ACTIVE" || g.fillState === "REBALANCING");

  const stackedGaps = [];
  for (const direction of ["bullish", "bearish"]) {
    const sameDirection = activeGaps.filter((g) => g.direction === direction);
    if (sameDirection.length >= 2) stackedGaps.push(...sameDirection);
  }

  const currentPrice = parseFloat(candles[candles.length - 1][4]);
  const nearestCandidates = activeGaps.length > 0 ? activeGaps : gaps;
  const nearestGap = nearestCandidates.length > 0 ? [...nearestCandidates].sort((a, b) => distanceToPrice(a, currentPrice) - distanceToPrice(b, currentPrice))[0] : null;
  const imbalanceDirection = nearestGap ? nearestGap.direction : null;

  let state;
  if (gaps.length === 0 || !nearestGap) state = "EMPTY";
  else if (stackedGaps.length > 0) state = "STACKED";
  else if (nearestGap.fillState === "ACTIVE") state = "IMBALANCED";
  else state = nearestGap.fillState; // REBALANCING | FILLED | EXHAUSTED batem 1:1 com o state do topo

  const score = nearestGap ? scoreFromAlignment(nearestGap.alignment) : 0;

  const dataQualityScore = Math.min(100, (candles.length / MIN_CANDLES_FOR_FVG) * 100);
  const contextCompletenessScore = nearestGap ? (nearestGap.alignment.totalWithDirection / 3) * 100 : 0;
  const confidence = Math.round(dataQualityScore * 0.5 + contextCompletenessScore * 0.5);

  const reasons = [];
  if (nearestGap) {
    const dirLabel = nearestGap.direction === "bullish" ? "Bullish" : "Bearish";
    const { agreeing, opposing } = nearestGap.alignment;
    if (opposing > agreeing) {
      reasons.push(`${dirLabel} FVG encontrado, mas ocorre contra o contexto atual (${opposing} contra, ${agreeing} a favor) -- baixa prioridade`);
    } else if (agreeing > opposing) {
      reasons.push(`${dirLabel} FVG alinhado com o contexto (${agreeing} a favor, ${opposing} contra) -- maior probabilidade de defesa`);
    } else {
      reasons.push(`${dirLabel} FVG sem alinhamento claro com o contexto (${agreeing} a favor, ${opposing} contra)`);
    }
    reasons.push(`Fill state: ${nearestGap.fillState}`);
  } else {
    reasons.push("Nenhum desequilíbrio (FVG) detectado no histórico");
  }
  if (stackedGaps.length > 0) reasons.push(`${stackedGaps.length} gaps empilhados na mesma direção`);

  const evidence = gaps.map((g) => ({
    type: g.direction === "bullish" ? "BULLISH_FVG" : "BEARISH_FVG",
    confidence: FILL_STATE_CONFIDENCE[g.fillState],
    weight: scoreFromAlignment(g.alignment),
    timestamp: new Date(candles[g.createdIndex][0]).toISOString(),
    payload: { low: g.low, high: g.high, fillState: g.fillState, alignment: g.alignment },
  }));

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles[candles.length - 1][0],
    startedAt,
    dependsOn: ["candles", "structure_brain", "liquidity_brain", "context_fusion"],
    extra: { gaps, activeGaps, filledGaps, stackedGaps, nearestGap, imbalanceDirection },
  });
}

module.exports = { analyzeFVG, computeAlignment, scoreFromAlignment, classifyGapFillState, directionFromContext };

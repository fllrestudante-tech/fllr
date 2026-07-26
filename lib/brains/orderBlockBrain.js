// Order Block Brain — não é "retângulo desenhado no gráfico", é uma
// hipótese institucional com ciclo de vida próprio (DETECTED → CONFIRMED
// → ACTIVE → TESTED → MITIGATED → BROKEN → INVALIDATED). Se apoia direto
// nos eventos BOS já detectados pelo Structure Brain (order blocks
// clássicos vêm de continuação de estrutura, não de reversão) -- não
// reimplementa detecção de impulso do zero.
//
// Mesmo padrão contextual do FVG Brain: recebe Structure/Liquidity/
// Context Fusion como entrada e julga alinhamento (score) -- reaproveita
// `computeAlignment`/`scoreFromAlignment`/`directionFromContext` de
// lib/brains/fvgBrain.js direto, são genéricos, não fazem nada específico
// de FVG.
//
// `strength` (força do movimento impulsivo que criou o bloco) e
// `freshness` (quão recente) são números novos, distintos de `score`
// (alinhamento com o contexto atual) -- um bloco pode ser muito forte e
// estar desalinhado, ou fraco e alinhado.
//
// Puramente observacional -- index.js::cycle() não depende disto.
//
// Backlog anotado, não corrigido agora (auditoria pedida pelo usuário):
// o `score` de alinhamento (mesma fórmula do FVG Brain) pode saturar em
// 100%/0% cedo demais em mercado fortemente direcional, perdendo poder de
// discriminação. Fatores futuros sugeridos pra quando houver meses de
// dado real: idade média dos blocos, % médio já mitigado, distância ao
// preço atual, densidade de blocos por faixa de preço.
//
// Próxima evolução prevista: Institutional Context (síntese de
// Liquidity+FVG+Order Blocks, não é um Brain novo) é o próximo item da
// sequência, ainda não construído.
const { detectOrderBlocks, trackBlockLifecycleData } = require("../marketStructure/orderBlock");
const { computeAlignment, scoreFromAlignment, directionFromContext } = require("./fvgBrain");
const { createBrainResult } = require("./brainResult");

const MIN_CANDLES_FOR_ORDER_BLOCKS = 200;
const MISSING_EVIDENCE = ["Institutional Context (Liquidity+FVG+Order Blocks)"];
const LIFECYCLE_CONFIDENCE = { DETECTED: 50, CONFIRMED: 70, ACTIVE: 100, TESTED: 80, MITIGATED: 50, BROKEN: 30, INVALIDATED: 10 };
const ALIVE_STAGES = ["DETECTED", "CONFIRMED", "ACTIVE", "TESTED"];

function classifyLifecycleStage(block, lifecycleData, { now, confirmAge, mitigationThreshold, exhaustionLookback }) {
  if (lifecycleData.brokenAtIndex != null) {
    const candlesSinceBroken = now - lifecycleData.brokenAtIndex;
    return candlesSinceBroken > exhaustionLookback ? "INVALIDATED" : "BROKEN";
  }
  if (lifecycleData.maxPenetrationPct >= mitigationThreshold) return "MITIGATED";
  if (lifecycleData.touched) return "TESTED";
  const age = now - block.createdIndex;
  if (age < confirmAge) return "DETECTED";
  return "CONFIRMED"; // ACTIVE é decidido no nível do Brain (o CONFIRMED mais próximo do preço)
}

function distanceToPrice(block, currentPrice) {
  if (currentPrice >= block.low && currentPrice <= block.high) return 0;
  return Math.min(Math.abs(currentPrice - block.low), Math.abs(currentPrice - block.high));
}

// Magnitude do movimento impulsivo que confirmou o bloco -- "quão forte
// foi o movimento institucional", independente de bater com o contexto
// atual (isso é `score`, não `strength`).
function computeStrength(block, candles) {
  const closeAtConfirm = parseFloat(candles[block.confirmedAtIndex][4]);
  const edge = block.direction === "bullish" ? block.high : block.low;
  const magnitudePct = (Math.abs(closeAtConfirm - edge) / edge) * 100;
  return Math.round(Math.min(100, magnitudePct * 20));
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
    extra: { zones: [], activeBlocks: [], mitigatedBlocks: [], brokenBlocks: [], invalidatedBlocks: [], dominantBlock: null, strength: 0, freshness: 0 },
  });
}

function analyzeOrderBlocks({ candles, structure, liquidity, context, confirmAge, mitigationThreshold, exhaustionLookback }) {
  const startedAt = Date.now();
  if (!candles || candles.length < MIN_CANDLES_FOR_ORDER_BLOCKS) return insufficientDataResult(candles, startedAt);

  const now = candles.length - 1;
  const currentPrice = parseFloat(candles[now][4]);

  let blocks = detectOrderBlocks(candles, structure.evidence || []).map((b) => {
    const lifecycleData = trackBlockLifecycleData(b, candles);
    const stage = classifyLifecycleStage(b, lifecycleData, { now, confirmAge, mitigationThreshold, exhaustionLookback });
    const alignment = computeAlignment(b.direction, { structure, liquidity, context });
    return { ...b, lifecycleData, stage, alignment };
  });

  // Promove o CONFIRMED mais próximo do preço atual pra ACTIVE -- "o que
  // importa agora" entre os blocos ainda intocados.
  const confirmedBlocks = blocks.filter((b) => b.stage === "CONFIRMED");
  if (confirmedBlocks.length > 0) {
    const nearestConfirmed = [...confirmedBlocks].sort((a, b) => distanceToPrice(a, currentPrice) - distanceToPrice(b, currentPrice))[0];
    blocks = blocks.map((b) => (b === nearestConfirmed ? { ...b, stage: "ACTIVE" } : b));
  }

  const activeBlocks = blocks.filter((b) => ALIVE_STAGES.includes(b.stage));
  const mitigatedBlocks = blocks.filter((b) => b.stage === "MITIGATED");
  const brokenBlocks = blocks.filter((b) => b.stage === "BROKEN");
  const invalidatedBlocks = blocks.filter((b) => b.stage === "INVALIDATED");

  const activeStageBlock = blocks.find((b) => b.stage === "ACTIVE");
  const dominantCandidates = activeStageBlock ? [activeStageBlock] : activeBlocks.length > 0 ? activeBlocks : blocks;
  const dominantBlock = dominantCandidates.length > 0 ? [...dominantCandidates].sort((a, b) => distanceToPrice(a, currentPrice) - distanceToPrice(b, currentPrice))[0] : null;

  const state = dominantBlock ? dominantBlock.stage : "EMPTY";
  const score = dominantBlock ? scoreFromAlignment(dominantBlock.alignment) : 0;
  const strength = dominantBlock ? computeStrength(dominantBlock, candles) : 0;
  const freshness = dominantBlock ? Math.max(0, 100 - (now - dominantBlock.createdIndex)) : 0;

  const dataQualityScore = Math.min(100, (candles.length / MIN_CANDLES_FOR_ORDER_BLOCKS) * 100);
  const contextCompletenessScore = dominantBlock ? (dominantBlock.alignment.totalWithDirection / 3) * 100 : 0;
  const confidence = Math.round(dataQualityScore * 0.5 + contextCompletenessScore * 0.5);

  const reasons = [];
  if (dominantBlock) {
    const dirLabel = dominantBlock.direction === "bullish" ? "Bullish" : "Bearish";
    const { agreeing, opposing } = dominantBlock.alignment;
    if (dominantBlock.stage === "MITIGATED" || dominantBlock.stage === "BROKEN" || dominantBlock.stage === "INVALIDATED") {
      reasons.push(`${dirLabel} Order Block ${dominantBlock.stage} -- estrutura já violada/enfraquecida`);
    } else if (opposing > agreeing) {
      reasons.push(`${dirLabel} Order Block ${dominantBlock.stage}, mas ocorre contra o contexto atual (${opposing} contra, ${agreeing} a favor) -- baixa prioridade`);
    } else if (agreeing > opposing) {
      reasons.push(`${dirLabel} Order Block ${dominantBlock.stage}, alinhado com o contexto (${agreeing} a favor, ${opposing} contra) -- alta probabilidade de defesa`);
    } else {
      reasons.push(`${dirLabel} Order Block ${dominantBlock.stage} sem alinhamento claro com o contexto`);
    }
  } else {
    reasons.push("Nenhum Order Block detectado no histórico");
  }

  const evidence = blocks.map((b) => ({
    type: b.direction === "bullish" ? "BULLISH_OB" : "BEARISH_OB",
    confidence: LIFECYCLE_CONFIDENCE[b.stage],
    weight: computeStrength(b, candles),
    timestamp: new Date(candles[b.createdIndex][0]).toISOString(),
    payload: { low: b.low, high: b.high, lifecycle: b.stage, alignment: b.alignment },
  }));

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles[now][0],
    startedAt,
    dependsOn: ["candles", "structure_brain", "liquidity_brain", "context_fusion"],
    extra: { zones: blocks, activeBlocks, mitigatedBlocks, brokenBlocks, invalidatedBlocks, dominantBlock, strength, freshness },
  });
}

module.exports = { analyzeOrderBlocks, classifyLifecycleStage, computeStrength };

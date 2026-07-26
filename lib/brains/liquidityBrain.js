// Liquidity Brain — responde "onde está a liquidez em relação ao preço",
// não só "houve um sweep". v1: Equal Highs/Lows (zonas) + Liquidity Sweep,
// a partir dos mesmos swings que o Structure Brain usa. FVG (imbalances)
// e Order Blocks são a fase seguinte da sequência (usam o contexto de
// estrutura+liquidez já disponível); Trapped Traders confirmado por OI e
// Stop Clusters (precisa order book/Level 2, não coletado) ficam
// reservados -- ver lib/marketStructure/liquidity.js pro detalhe de cada
// limitação. Puramente observacional -- index.js::cycle() não depende
// disto.
const { detectSwingHighs, detectSwingLows } = require("../marketStructure/swingDetector");
const { clusterEqualLevels, detectSweeps, annotateReversalConfirmation } = require("../marketStructure/liquidity");
const { createBrainResult } = require("./brainResult");

const MIN_CANDLES_FOR_LIQUIDITY = 200;
const RECENT_SWEEP_WINDOW = 20; // candles -- um sweep dentro dessa janela domina o state (mesma lógica do CHOCH no Structure Brain: o evento mais urgente vence a leitura estática)

const MISSING_EVIDENCE = [
  "Fair Value Gap (FVG)",
  "Order Blocks",
  "Stop Clusters (requer order book/Level 2, não coletado)",
  "Trapped Traders confirmado por OI (requer Context Fusion)",
];

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
      zones: { above: [], below: [] },
      sweeps: [],
      imbalances: null,
      trappedTraders: null,
    },
  });
}

function buildZoneEvidence(zone, type, candles) {
  const latestSwingIndex = Math.max(...zone.swingIndexes);
  return {
    type,
    confidence: Math.min(100, zone.touchCount * 30),
    weight: zone.touchCount,
    timestamp: new Date(candles[latestSwingIndex][0]).toISOString(),
    payload: { level: zone.level, touchCount: zone.touchCount, swingIndexes: zone.swingIndexes },
  };
}

function sweepMagnitudePct(sweep, candles) {
  const wickPrice = sweep.type === "SWEEP_HIGH" ? parseFloat(candles[sweep.index][2]) : parseFloat(candles[sweep.index][3]);
  return (Math.abs(wickPrice - sweep.level) / sweep.level) * 100;
}

function buildSweepEvidence(sweep, candles) {
  return {
    type: sweep.type,
    confidence: Math.round(Math.min(100, sweepMagnitudePct(sweep, candles) * 30)),
    weight: sweep.reversalConfirmed === true ? 2 : 1,
    timestamp: new Date(candles[sweep.index][0]).toISOString(),
    payload: { level: sweep.level, index: sweep.index, reversalConfirmed: sweep.reversalConfirmed },
  };
}

function analyzeLiquidity({ candles, lookback, equalTolerancePct, sweepReversalLookahead }) {
  const startedAt = Date.now();
  if (!candles || candles.length < MIN_CANDLES_FOR_LIQUIDITY) return insufficientDataResult(candles, startedAt);

  const swingHighs = detectSwingHighs(candles, lookback);
  const swingLows = detectSwingLows(candles, lookback);

  const equalHighZones = clusterEqualLevels(swingHighs, equalTolerancePct);
  const equalLowZones = clusterEqualLevels(swingLows, equalTolerancePct);

  const rawSweeps = detectSweeps(candles, swingHighs, swingLows, { lookback });
  const sweeps = annotateReversalConfirmation(rawSweeps, candles, sweepReversalLookahead);

  const lastIndex = candles.length - 1;
  const currentPrice = parseFloat(candles[lastIndex][4]);
  const lastSweep = sweeps.length > 0 ? sweeps[sweeps.length - 1] : null;
  const recentSweep = lastSweep && lastIndex - lastSweep.index <= RECENT_SWEEP_WINDOW ? lastSweep : null;

  // Zonas classificadas por POSIÇÃO em relação ao preço atual, não pela
  // origem (high ou low) -- liquidez resta acima ou abaixo por causa de
  // onde o nível está agora, não de que tipo de swing o formou.
  const allZones = [
    ...equalHighZones.map((z) => ({ ...z, type: "EQUAL_HIGH" })),
    ...equalLowZones.map((z) => ({ ...z, type: "EQUAL_LOW" })),
  ];
  const zonesAbove = allZones.filter((z) => z.level > currentPrice);
  const zonesBelow = allZones.filter((z) => z.level < currentPrice);
  const aboveWeight = zonesAbove.reduce((sum, z) => sum + z.touchCount, 0);
  const belowWeight = zonesBelow.reduce((sum, z) => sum + z.touchCount, 0);

  let state;
  if (recentSweep) {
    state = recentSweep.type === "SWEEP_HIGH" ? "SWEPT_HIGH" : "SWEPT_LOW";
  } else if (aboveWeight > belowWeight) {
    state = "LIQUIDITY_ABOVE";
  } else if (belowWeight > aboveWeight) {
    state = "LIQUIDITY_BELOW";
  } else {
    state = "BALANCED";
  }

  // Score: hipótese não validada por backtest (mesma disciplina de
  // sempre) -- magnitude do pavio nos estados de sweep; desequilíbrio
  // ponderado por touchCount entre zonas acima/abaixo nos demais.
  let score = 0;
  if (recentSweep) {
    score = Math.round(Math.min(100, sweepMagnitudePct(recentSweep, candles) * 30));
  } else if (state === "LIQUIDITY_ABOVE" || state === "LIQUIDITY_BELOW") {
    const totalWeight = aboveWeight + belowWeight;
    score = totalWeight > 0 ? Math.round((Math.abs(aboveWeight - belowWeight) / totalWeight) * 100) : 0;
  }

  // Confidence: 3 pilares (não força um 4º artificial só pra imitar o
  // Structure Brain) -- qualidade do dado + quantidade de evidência +
  // taxa de confirmação de reversão dos sweeps julgáveis.
  const dataQualityScore = Math.min(100, (candles.length / MIN_CANDLES_FOR_LIQUIDITY) * 100);
  const evidenceQuantityScore = Math.min(100, (equalHighZones.length + equalLowZones.length + sweeps.length) * 10);
  const judgedSweeps = sweeps.filter((s) => s.reversalConfirmed !== null);
  const confirmedSweeps = judgedSweeps.filter((s) => s.reversalConfirmed === true);
  const reversalRateScore = judgedSweeps.length > 0 ? Math.round((confirmedSweeps.length / judgedSweeps.length) * 100) : 100;
  const confidence = Math.round(dataQualityScore * 0.4 + evidenceQuantityScore * 0.4 + reversalRateScore * 0.2);

  const reasons = [];
  if (recentSweep) {
    const directionLabel = recentSweep.type === "SWEEP_HIGH" ? "de alta" : "de baixa";
    reasons.push(`Sweep ${directionLabel} detectado (nível ${recentSweep.level.toFixed(2)})`);
    if (recentSweep.reversalConfirmed === true) reasons.push("Reversão confirmada depois do sweep");
    else if (recentSweep.reversalConfirmed === false) reasons.push("Reversão ainda não confirmada depois do sweep");
  }
  reasons.push(`${zonesAbove.length} zona(s) de liquidez acima do preço, ${zonesBelow.length} abaixo`);
  if (allZones.length > 0) {
    const avgTouch = (allZones.reduce((s, z) => s + z.touchCount, 0) / allZones.length).toFixed(1);
    reasons.push(`Touch count médio das zonas: ${avgTouch}`);
  }

  const evidence = [
    ...equalHighZones.map((z) => buildZoneEvidence(z, "EQUAL_HIGH", candles)),
    ...equalLowZones.map((z) => buildZoneEvidence(z, "EQUAL_LOW", candles)),
    ...sweeps.map((s) => buildSweepEvidence(s, candles)),
  ];

  const trappedTraders = recentSweep
    ? {
        side: recentSweep.type === "SWEEP_HIGH" ? "longs" : "shorts",
        confirmed: recentSweep.reversalConfirmed,
        note: "proxy de preço, não confirmado por OI/volume real",
      }
    : null;

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence: MISSING_EVIDENCE,
    sourceDataTime: candles[lastIndex][0],
    startedAt,
    dependsOn: ["candles"],
    extra: {
      zones: { above: zonesAbove, below: zonesBelow },
      sweeps,
      imbalances: null,
      trappedTraders,
    },
  });
}

module.exports = { analyzeLiquidity };

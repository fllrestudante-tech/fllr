// Context Fusion — combina Market Brain + Structure Brain + Liquidity
// Brain só como LEITURA (nenhuma decisão de trade). Detecta conflitos
// entre eles e produz uma confiança fundida que cai quando os Brains
// discordam entre si, não só quando falta dado -- é a peça central pedida
// pelo usuário ("confidence 98% mas conflita não deveria valer tanto").
//
// Recebe os 3 BrainResult já computados, não faz I/O nenhum -- puro.
// Devolve um BrainResult também (mesmo helper de sempre): na visão do
// usuário, Context Fusion é mais um Brain, só que lê outros Brains em vez
// de dado cru (por isso metadata.dependsOn aponta pra nomes de Brain, não
// domínios de dado).
//
// Próxima evolução prevista (documentado, não implementada nesta versão):
// Volume/Narrative/Whale Brain entram nesta mesma fusão quando existirem,
// sem trocar a forma; "stability" (quão consistente a leitura fica ao
// longo de várias rodadas) precisa de histórico persistido de snapshots
// anteriores -- este módulo só fusiona 1 instante, não guarda o passado
// (isso é papel do scripts/metricsSampler.js, que já persiste o resultado
// em runtime/metrics/history/context.jsonl).
const { createBrainResult } = require("./brainResult");

// Direção lida de cada Brain -- hipótese documentada, não validada por
// backtest (mesma disciplina de sempre). LIQUIDITY_ABOVE/BELOW são lidos
// como "ímã" (preço atraído até a liquidez), não como resistência/suporte
// -- escolha discutível, registrada como tal (mesmo espírito do
// EUPHORIA/PANIC do Market Brain).
function directionFromMarket(market) {
  if (market.trend.state === "TRENDING_BULL") return "bull";
  if (market.trend.state === "TRENDING_BEAR") return "bear";
  return null;
}
function directionFromStructure(structure) {
  if (structure.trend.bias === "bullish") return "bull";
  if (structure.trend.bias === "bearish") return "bear";
  return null;
}
function directionFromLiquidity(liquidity) {
  if (liquidity.state === "SWEPT_HIGH") return "bear";
  if (liquidity.state === "SWEPT_LOW") return "bull";
  if (liquidity.state === "LIQUIDITY_ABOVE") return "bull";
  if (liquidity.state === "LIQUIDITY_BELOW") return "bear";
  return null;
}

const DIRECTION_LABEL = { bull: "alta", bear: "baixa" };

/** Só conta como conflito quando os dois lados têm direção não-nula e discordam. */
function detectConflicts(directionsByBrain) {
  const entries = Object.entries(directionsByBrain);
  const conflicts = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, dirA] = entries[i];
      const [nameB, dirB] = entries[j];
      if (dirA && dirB && dirA !== dirB) {
        conflicts.push(`${nameA} aponta ${DIRECTION_LABEL[dirA]}, mas ${nameB} aponta ${DIRECTION_LABEL[dirB]}`);
      }
    }
  }
  return conflicts;
}

function confidencePenaltyFor(conflictCount) {
  if (conflictCount === 0) return 1;
  if (conflictCount === 1) return 0.7;
  return 0.4;
}

function fuseContext({ market, structure, liquidity }) {
  const startedAt = Date.now();

  const directionsByBrain = {
    "Market Brain": directionFromMarket(market),
    "Structure Brain": directionFromStructure(structure),
    "Liquidity Brain": directionFromLiquidity(liquidity),
  };
  const conflicts = detectConflicts(directionsByBrain);

  const brains = [
    { name: "Market Brain", brain: market, direction: directionsByBrain["Market Brain"] },
    { name: "Structure Brain", brain: structure, direction: directionsByBrain["Structure Brain"] },
    { name: "Liquidity Brain", brain: liquidity, direction: directionsByBrain["Liquidity Brain"] },
  ];

  let weightedSum = 0;
  let totalWeight = 0;
  for (const { brain, direction } of brains) {
    const value = direction === "bull" ? 1 : direction === "bear" ? -1 : 0;
    const weight = brain.confidence / 100;
    weightedSum += value * weight;
    totalWeight += weight;
  }
  const directionalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const state = directionalScore > 0.15 ? "FUSED_BULLISH" : directionalScore < -0.15 ? "FUSED_BEARISH" : "FUSED_NEUTRAL";
  const score = Math.round(Math.abs(directionalScore) * 100);

  const avgConfidence = Math.round(brains.reduce((sum, { brain }) => sum + brain.confidence, 0) / brains.length);
  const confidence = Math.round(avgConfidence * confidencePenaltyFor(conflicts.length));

  const reasons = brains.filter(({ brain }) => brain.reasons.length > 0).map(({ name, brain }) => `${name}: ${brain.reasons[0]}`);
  reasons.push(...conflicts);

  const evidence = brains.map(({ name, brain }) => ({
    type: name.toUpperCase().replace(/\s+/g, "_"),
    confidence: brain.confidence,
    weight: brain.score,
    timestamp: brain.metadata.generatedAt,
    payload: { state: brain.state, score: brain.score, confidence: brain.confidence },
  }));

  const missingEvidence = [];
  for (const { brain } of brains) {
    for (const m of brain.missingEvidence) if (!missingEvidence.includes(m)) missingEvidence.push(m);
  }
  for (const futureBrain of ["Volume Brain", "Narrative Brain", "Whale Brain"]) {
    if (!missingEvidence.includes(futureBrain)) missingEvidence.push(futureBrain);
  }

  return createBrainResult({
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence,
    sourceDataTime: market.metadata.sourceDataTime,
    startedAt,
    dependsOn: ["market_brain", "structure_brain", "liquidity_brain"],
    extra: { conflicts },
  });
}

module.exports = { fuseContext, directionFromMarket, directionFromStructure, directionFromLiquidity, detectConflicts, confidencePenaltyFor };

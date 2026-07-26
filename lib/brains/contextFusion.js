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

// Direção majoritária entre os 3 Brains (ignora null) -- empate (incluindo
// 0 votos) devolve null, sem consenso pra comparar contra.
function computeMajorityDirection(directions) {
  const counts = { bull: 0, bear: 0 };
  for (const dir of directions) {
    if (dir === "bull") counts.bull++;
    else if (dir === "bear") counts.bear++;
  }
  if (counts.bull > counts.bear) return "bull";
  if (counts.bear > counts.bull) return "bear";
  return null;
}

function severityFromConfidence(confidence) {
  if (confidence >= 70) return "high";
  if (confidence >= 40) return "medium";
  return "low";
}

/**
 * Conflito = um Brain com direção própria (não-nula) que discorda do
 * restante -- nomeia especificamente QUEM está indo contra o consenso, não
 * só "esses dois discordam" (diferente de comparar todos os pares entre
 * si). Com maioria clara (2-1), só o lado minoritário conflita. **Sem
 * maioria (empate 1-1, ex: bull/bear/null)** não existe um "consenso" pra
 * comparar contra -- nesse caso os dois lados que discordam entre si são
 * ambos marcados (simétrico), em vez de silenciosamente não reportar
 * nenhum conflito só porque ninguém tem maioria. `reason` reaproveita o
 * próprio `reasons[0]` do Brain (nunca fabrica uma descrição nova tipo
 * "Distribution zone detected" sem lastro real).
 */
function detectConflicts(brains, majorityDirection) {
  const directions = brains.map((b) => b.direction);
  return brains
    .filter(({ direction }) => {
      if (!direction) return false;
      if (majorityDirection) return direction !== majorityDirection;
      return directions.some((other) => other && other !== direction); // empate: conflita com quem discordar
    })
    .map(({ shortName, brain }) => ({
      brain: shortName,
      severity: severityFromConfidence(brain.confidence),
      reason: brain.reasons[0] || "sem detalhe disponível",
    }));
}

function confidencePenaltyFor(conflictCount) {
  if (conflictCount === 0) return 1;
  if (conflictCount === 1) return 0.7;
  return 0.4;
}

const NARRATIVE_BY_STATE = {
  FUSED_BULLISH: "Continuação de Alta",
  FUSED_BEARISH: "Continuação de Baixa",
  FUSED_NEUTRAL: "Indecisão",
};

// Narrativa em texto -- prepara terreno pra dashboard/replay/análise
// histórica (pedido explícito do usuário), sem mudar nenhuma decisão.
// "Enfraquecendo" quando o Structure Brain já mostra WEAK/BROKEN mesmo com
// o restante ainda apontando na direção dominante -- primeiro sinal de
// que a continuação pode não durar.
function computeDominantNarrative(state, structure) {
  if (state === "FUSED_NEUTRAL") return NARRATIVE_BY_STATE.FUSED_NEUTRAL;
  const weakening = structure.state === "WEAK" || structure.state === "BROKEN";
  if (weakening) return state === "FUSED_BULLISH" ? "Alta com Estrutura Enfraquecendo" : "Baixa com Estrutura Enfraquecendo";
  return NARRATIVE_BY_STATE[state];
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

// null quando não há conflito -- não fabrica uma narrativa secundária pra
// preencher o campo à toa.
function computeSecondaryNarrative(conflicts) {
  if (conflicts.length === 0) return null;
  const worst = [...conflicts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0];
  return `Possível divergência: ${worst.brain} discorda (${worst.reason})`;
}

function fuseContext({ market, structure, liquidity }) {
  const startedAt = Date.now();

  const brains = [
    { name: "Market Brain", shortName: "Market", brain: market, direction: directionFromMarket(market) },
    { name: "Structure Brain", shortName: "Structure", brain: structure, direction: directionFromStructure(structure) },
    { name: "Liquidity Brain", shortName: "Liquidity", brain: liquidity, direction: directionFromLiquidity(liquidity) },
  ];

  const majorityDirection = computeMajorityDirection(brains.map((b) => b.direction));
  const conflicts = detectConflicts(brains, majorityDirection);

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

  const dominantNarrative = computeDominantNarrative(state, structure);
  const secondaryNarrative = computeSecondaryNarrative(conflicts);

  const reasons = brains.filter(({ brain }) => brain.reasons.length > 0).map(({ name, brain }) => `${name}: ${brain.reasons[0]}`);
  reasons.push(...conflicts.map((c) => `${c.brain} discorda do consenso (${c.severity}): ${c.reason}`));

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
    extra: { conflicts, dominantNarrative, secondaryNarrative },
  });
}

module.exports = {
  fuseContext,
  directionFromMarket,
  directionFromStructure,
  directionFromLiquidity,
  computeMajorityDirection,
  detectConflicts,
  confidencePenaltyFor,
  computeDominantNarrative,
  computeSecondaryNarrative,
};

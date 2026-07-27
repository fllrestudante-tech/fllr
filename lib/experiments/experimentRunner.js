// Experiments Engine v1 -- reaproveita 100% as funções estatísticas que já
// existem em lib/replayEngine.js/lib/brainAnalytics.js. Nenhuma lógica de
// cálculo nova aqui: cada `kind` é só um dispatch pra função já testada,
// mais uma normalização pro formato de `metrics.replay` do Research Object
// (lib/registry/researchObject.js). Um Experiment é apenas mais um `type`
// dessa mesma forma comum -- não um subsistema à parte.
const { computeStats } = require("../replayEngine");
const { computeBrainAccuracy, computeMarginalContribution, computeRedundancy } = require("../brainAnalytics");

function runCombo(definition, snapshots) {
  const rows = computeStats(snapshots, definition.brainKeys);
  const top = rows[0] || { comboKey: null, count: 0, successRate: 0, avgForwardReturnPct: 0, avgDrawdownPct: 0, confidenceLabel: "Baixa" };
  return {
    metricsReplay: { snapshots: top.count, winrate: top.successRate, avgRR: top.avgForwardReturnPct },
    raw: {
      dominantCombo: top.comboKey,
      avgDrawdownPct: top.avgDrawdownPct,
      confidenceLabel: top.confidenceLabel,
      totalCombos: rows.length,
      allRows: rows,
    },
  };
}

function runBrainAccuracy(definition, snapshots, outcomeThresholdPct) {
  const result = computeBrainAccuracy(snapshots, definition.brainKey, outcomeThresholdPct);
  return {
    metricsReplay: { snapshots: result.totalCalls, accuracy: result.accuracy, precision: result.precision, recall: result.recall },
    raw: { brainKey: result.brainKey },
  };
}

function runMarginalContribution(definition, snapshots, outcomeThresholdPct) {
  const ladder = computeMarginalContribution(snapshots, definition.brainKeys, outcomeThresholdPct);
  const tip = ladder[ladder.length - 1] || { combo: [], sampleSize: 0, accuracy: 0 };
  return {
    metricsReplay: { snapshots: tip.sampleSize, accuracy: tip.accuracy },
    raw: { ladder },
  };
}

function runRedundancy(definition, snapshots) {
  const result = computeRedundancy(snapshots, definition.targetBrainKey, definition.explainerBrainKeys);
  return {
    metricsReplay: { snapshots: result.sampleSize, agreementRatePct: result.agreementRatePct },
    raw: { targetBrainKey: result.targetBrainKey, explainerBrainKeys: result.explainerBrainKeys },
  };
}

const RUNNERS = {
  combo: (definition, snapshots) => runCombo(definition, snapshots),
  brainAccuracy: (definition, snapshots, opts) => runBrainAccuracy(definition, snapshots, opts.outcomeThresholdPct),
  marginalContribution: (definition, snapshots, opts) => runMarginalContribution(definition, snapshots, opts.outcomeThresholdPct),
  redundancy: (definition, snapshots) => runRedundancy(definition, snapshots),
};

function runExperiment(definition, snapshots, { outcomeThresholdPct } = {}) {
  const runner = RUNNERS[definition.kind];
  if (!runner) {
    throw new Error(`kind desconhecido: "${definition.kind}" (esperado: ${Object.keys(RUNNERS).join(", ")})`);
  }
  return runner(definition, snapshots, { outcomeThresholdPct });
}

// `status`/`maturity`/`tags` só recebem default na primeira criação --
// rodar o experimento de novo NUNCA reseta curadoria humana já feita
// (ex: alguém promoveu pra "validated" depois de revisar). maturity=2 no
// default reflete que ter `metrics.replay` real já é evidência de nível
// "Replay" (mesma escala de lib/researchMaturity.js) -- não é mais só uma
// ideia a partir do primeiro run com dado real.
function toResearchObjectFields(definition, runResult, { existing = null } = {}) {
  return {
    ...(existing || {}),
    id: definition.id,
    type: "experiment",
    name: definition.name,
    description: definition.hypothesis,
    status: (existing && existing.status) || "research",
    maturity: existing && existing.maturity != null ? existing.maturity : 2,
    tags: (existing && existing.tags) || ["experiment", definition.kind],
    dependsOn: definition.relatedIds,
    metrics: { ...((existing && existing.metrics) || {}), replay: runResult.metricsReplay },
  };
}

module.exports = { runExperiment, toResearchObjectFields };

const test = require("node:test");
const assert = require("node:assert/strict");
const { runExperiment, toResearchObjectFields } = require("../../lib/experiments/experimentRunner");

function brain(state, direction) {
  return { state, direction };
}

function snapshot({ outcome, forwardReturnPct, brains }) {
  return { outcome, forwardReturnPct, maxAdverseExcursionPct: 0.5, brains };
}

// 2 snapshots compartilham a mesma combinação structure+liquidity (o "grupo
// dominante"), o 3º é uma combinação diferente -- suficiente pra exercitar
// dispatch/agrupamento sem precisar recalcular os números à mão (a
// correção estatística em si já é coberta por test/brainAnalytics.test.js
// e test/contextFusion.test.js/etc).
const snapshots = [
  snapshot({
    outcome: "SUCCESS",
    forwardReturnPct: 1,
    brains: {
      structure: brain("GOOD", "bull"),
      liquidity: brain("LIQUIDITY_ABOVE", "bull"),
      fvg: brain("STACKED", "bull"),
      orderBlock: brain("ACTIVE", "bull"),
    },
  }),
  snapshot({
    outcome: "FAIL",
    forwardReturnPct: -1,
    brains: {
      structure: brain("GOOD", "bull"),
      liquidity: brain("LIQUIDITY_ABOVE", "bull"),
      fvg: brain("STACKED", "bull"),
      orderBlock: brain("ACTIVE", "bull"),
    },
  }),
  snapshot({
    outcome: "SUCCESS",
    forwardReturnPct: 1,
    brains: {
      structure: brain("BROKEN", "bear"),
      liquidity: brain("SWEPT_LOW", "bear"),
      fvg: brain("EXHAUSTED", "bear"),
      orderBlock: brain("BROKEN", "bear"),
    },
  }),
];

test("runExperiment: kind=combo despacha pra computeStats e resume a combinação dominante", () => {
  const definition = { id: "x", kind: "combo", brainKeys: ["structure", "liquidity"] };
  const { metricsReplay, raw } = runExperiment(definition, snapshots, { outcomeThresholdPct: 0.3 });
  assert.equal(metricsReplay.snapshots, 2, "as duas primeiras compartilham a mesma combinação de estados");
  assert.equal(typeof metricsReplay.winrate, "number");
  assert.equal(typeof metricsReplay.avgRR, "number");
  assert.ok(raw.dominantCombo.includes("structure:GOOD"));
  assert.equal(raw.totalCombos, 2);
});

test("runExperiment: kind=brainAccuracy despacha pra computeBrainAccuracy", () => {
  const definition = { id: "x", kind: "brainAccuracy", brainKey: "fvg" };
  const { metricsReplay, raw } = runExperiment(definition, snapshots, { outcomeThresholdPct: 0.3 });
  assert.equal(metricsReplay.snapshots, 3);
  assert.equal(typeof metricsReplay.accuracy, "number");
  assert.equal(typeof metricsReplay.precision, "number");
  assert.equal(typeof metricsReplay.recall, "number");
  assert.equal(raw.brainKey, "fvg");
});

test("runExperiment: kind=marginalContribution despacha pra computeMarginalContribution e usa o topo da escada", () => {
  const definition = { id: "x", kind: "marginalContribution", brainKeys: ["structure", "liquidity"] };
  const { metricsReplay, raw } = runExperiment(definition, snapshots, { outcomeThresholdPct: 0.3 });
  assert.equal(raw.ladder.length, 2);
  assert.equal(metricsReplay.snapshots, raw.ladder[raw.ladder.length - 1].sampleSize);
});

test("runExperiment: kind=redundancy despacha pra computeRedundancy", () => {
  const definition = { id: "x", kind: "redundancy", targetBrainKey: "fvg", explainerBrainKeys: ["liquidity", "orderBlock"] };
  const { metricsReplay, raw } = runExperiment(definition, snapshots, {});
  assert.equal(raw.targetBrainKey, "fvg");
  assert.deepEqual(raw.explainerBrainKeys, ["liquidity", "orderBlock"]);
  assert.equal(typeof metricsReplay.agreementRatePct, "number");
});

test("runExperiment: kind desconhecido lança erro claro", () => {
  assert.throws(() => runExperiment({ id: "x", kind: "nao-existe" }, snapshots, {}), /kind desconhecido/);
});

test("toResearchObjectFields: cria com status=research e maturity=2 quando não existe ainda", () => {
  const definition = { id: "experiment-x", name: "X", hypothesis: "H", kind: "brainAccuracy", relatedIds: ["brain-fvg"] };
  const fields = toResearchObjectFields(definition, { metricsReplay: { snapshots: 3, accuracy: 50 } });
  assert.equal(fields.status, "research");
  assert.equal(fields.maturity, 2);
  assert.deepEqual(fields.dependsOn, ["brain-fvg"]);
  assert.deepEqual(fields.metrics.replay, { snapshots: 3, accuracy: 50 });
  assert.deepEqual(fields.tags, ["experiment", "brainAccuracy"]);
});

test("toResearchObjectFields: preserva status/tags/maturity de um objeto existente, sem apagar outras fases de metrics", () => {
  const definition = { id: "experiment-x", name: "X", hypothesis: "H", kind: "brainAccuracy", relatedIds: ["brain-fvg"] };
  const existing = { status: "validated", maturity: 3, tags: ["curado"], metrics: { paperTrading: { winrate: 60 } } };
  const fields = toResearchObjectFields(definition, { metricsReplay: { snapshots: 5, accuracy: 60 } }, { existing });
  assert.equal(fields.status, "validated");
  assert.equal(fields.maturity, 3);
  assert.deepEqual(fields.tags, ["curado"]);
  assert.deepEqual(fields.metrics.replay, { snapshots: 5, accuracy: 60 });
  assert.deepEqual(fields.metrics.paperTrading, { winrate: 60 });
});

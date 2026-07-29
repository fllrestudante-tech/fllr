const test = require("node:test");
const assert = require("node:assert/strict");
const { createFeature, createUnknownFeature, isFeatureActive } = require("../../lib/featureBuilder/featureShape");

test("createFeature: monta o formato certo (id/version/feature/featureType/observation/interpretation/strength/confidence/metadata)", () => {
  const f = createFeature({
    id: "FEATURE_FUNDING_EXTREME",
    feature: "FundingExtreme",
    featureType: "EXTREME",
    version: 1,
    observation: { percentile: 98, zscore: 4 },
    state: "EXTREME",
    direction: "above",
    confidence: 91,
    source: "StatisticalResolver",
    resolverVersion: 1,
    statisticsVersion: 1,
  });

  assert.equal(f.id, "FEATURE_FUNDING_EXTREME");
  assert.equal(f.version, 1);
  assert.equal(f.feature, "FundingExtreme");
  assert.equal(f.featureType, "EXTREME");
  assert.deepEqual(f.observation, { percentile: 98, zscore: 4 });
  assert.deepEqual(f.interpretation, { state: "EXTREME", direction: "above" });
  assert.equal(f.confidence, 91);
  assert.equal(f.metadata.source, "StatisticalResolver");
  assert.equal(f.metadata.resolverVersion, 1);
  assert.equal(f.metadata.statisticsVersion, 1);
  assert.equal(f.metadata.knowledgeVersion, 1);
  assert.ok(f.metadata.computedAt);
});

test("createFeature: strength deriva do zscore (|zscore|*25, saturado em 100)", () => {
  assert.equal(createFeature({ id: "x", feature: "x", featureType: "ANOMALY", observation: { zscore: 4 }, state: "NORMAL", confidence: 50, source: "s" }).strength, 100);
  assert.equal(createFeature({ id: "x", feature: "x", featureType: "ANOMALY", observation: { zscore: 1 }, state: "NORMAL", confidence: 50, source: "s" }).strength, 25);
  assert.equal(createFeature({ id: "x", feature: "x", featureType: "ANOMALY", observation: { zscore: 0 }, state: "NORMAL", confidence: 50, source: "s" }).strength, 0);
  assert.equal(createFeature({ id: "x", feature: "x", featureType: "ANOMALY", observation: {}, state: "NORMAL", confidence: 50, source: "s" }).strength, 0, "sem zscore não lança erro, strength=0");
});

test("createFeature: state fora do enum categórico lança erro claro", () => {
  assert.throws(
    () => createFeature({ id: "x", feature: "x", featureType: "ANOMALY", observation: {}, state: "TRUE", confidence: 1, source: "s" }),
    /state inválido/
  );
});

test("createFeature: featureType fora do enum lança erro claro", () => {
  assert.throws(
    () => createFeature({ id: "x", feature: "x", featureType: "BOGUS", observation: {}, state: "NORMAL", confidence: 1, source: "s" }),
    /featureType inválido/
  );
});

test("createUnknownFeature: state UNKNOWN, confidence 0, nunca lança erro", () => {
  const f = createUnknownFeature({ id: "FEATURE_X", feature: "X", featureType: "ANOMALY" });
  assert.equal(f.interpretation.state, "UNKNOWN");
  assert.equal(f.confidence, 0);
  assert.equal(f.metadata.resolverVersion, null);
});

test("isFeatureActive: true só pra HIGH/EXTREME", () => {
  const base = { id: "x", feature: "x", featureType: "ANOMALY", observation: {}, confidence: 1, source: "s" };
  assert.equal(isFeatureActive(createFeature({ ...base, state: "HIGH" })), true);
  assert.equal(isFeatureActive(createFeature({ ...base, state: "EXTREME" })), true);
  assert.equal(isFeatureActive(createFeature({ ...base, state: "NORMAL" })), false);
  assert.equal(isFeatureActive(createFeature({ ...base, state: "LOW" })), false);
  assert.equal(isFeatureActive(createFeature({ ...base, state: "UNKNOWN" })), false);
});

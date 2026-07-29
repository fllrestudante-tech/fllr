// Feature atômica sobre a métrica `openInterest` -- "Expansion" só conta
// quando o OI está crescendo (direction "above"), nunca em qualquer
// nível extremo (um OI extremamente BAIXO não é "expansão").
const { resolveMetricSignal } = require("../../knowledgeBase/statisticalResolver");
const { levelFromPercentile } = require("../levelFromPercentile");
const { createFeature, createUnknownFeature } = require("../featureShape");
const { FEATURE_OI_EXPANSION } = require("../featureIds");

function buildOiExpansion(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_OI_EXPANSION, feature: "OIExpansion", featureType: "EXPANSION" });

  const observation = {
    percentile: signal.observation.percentile,
    zscore: signal.observation.zscore,
    value: signal.observation.value,
    resolverInterpretation: signal.interpretation,
  };
  const { level, direction } = levelFromPercentile(observation.percentile);
  const state = direction === "above" ? level : "NORMAL";

  return createFeature({
    id: FEATURE_OI_EXPANSION,
    feature: "OIExpansion",
    featureType: "EXPANSION",
    observation,
    state,
    direction,
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

function buildOpenInterestFeatures(db, symbol) {
  const signal = resolveMetricSignal(db, symbol, "openInterest");
  return [buildOiExpansion(signal)];
}

module.exports = { buildOpenInterestFeatures, buildOiExpansion };

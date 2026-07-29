// Feature atômica sobre a métrica `volume` -- anomalia em qualquer
// direção conta (volume extremamente alto OU baixo é igualmente
// anômalo), diferente de OIExpansion/SpreadExpansion que só contam uma
// direção.
const { resolveMetricSignal } = require("../../knowledgeBase/statisticalResolver");
const { levelFromPercentile } = require("../levelFromPercentile");
const { createFeature, createUnknownFeature } = require("../featureShape");
const { FEATURE_VOLUME_ANOMALY } = require("../featureIds");

function buildVolumeAnomaly(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_VOLUME_ANOMALY, feature: "VolumeAnomaly", featureType: "ANOMALY" });

  const observation = {
    percentile: signal.observation.percentile,
    zscore: signal.observation.zscore,
    value: signal.observation.value,
    resolverInterpretation: signal.interpretation,
  };
  const { level, direction } = levelFromPercentile(observation.percentile);

  return createFeature({
    id: FEATURE_VOLUME_ANOMALY,
    feature: "VolumeAnomaly",
    featureType: "ANOMALY",
    observation,
    state: level,
    direction,
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

function buildVolumeFeatures(db, symbol) {
  const signal = resolveMetricSignal(db, symbol, "volume");
  return [buildVolumeAnomaly(signal)];
}

module.exports = { buildVolumeFeatures, buildVolumeAnomaly };

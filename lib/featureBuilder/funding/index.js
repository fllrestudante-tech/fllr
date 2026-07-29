// Features atômicas sobre a métrica `funding` -- só chama
// lib/knowledgeBase/statisticalResolver.js::resolveMetricSignal (nunca a
// Storage direto). 2 funções por Feature (separação conceitual Builder/
// Evaluator dentro do mesmo arquivo, física quando a quantidade de
// Features crescer de verdade): `observeX` extrai os fatos brutos
// relevantes, `interpretX` decide o `state`/`direction` categórico com
// critério PRÓPRIO do Feature Builder (nunca copia `interpretation.level`
// do Resolver -- fica só como referência auxiliar em `resolverInterpretation`).
const { resolveMetricSignal } = require("../../knowledgeBase/statisticalResolver");
const { levelFromPercentile } = require("../levelFromPercentile");
const { createFeature, createUnknownFeature } = require("../featureShape");
const { FEATURE_FUNDING_EXTREME, FEATURE_FUNDING_ACCELERATION } = require("../featureIds");

function observeFunding(signal) {
  return {
    percentile: signal.observation.percentile,
    zscore: signal.observation.zscore,
    value: signal.observation.value,
    trend: signal.observation.trend,
    acceleration: signal.observation.acceleration,
    resolverInterpretation: signal.interpretation,
  };
}

function buildFundingExtreme(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_FUNDING_EXTREME, feature: "FundingExtreme", featureType: "EXTREME" });

  const observation = observeFunding(signal);
  const { level, direction } = levelFromPercentile(observation.percentile);

  return createFeature({
    id: FEATURE_FUNDING_EXTREME,
    feature: "FundingExtreme",
    featureType: "EXTREME",
    observation,
    state: level,
    direction,
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

/**
 * "Acelerando" = velocidade aumentando NA MESMA DIREÇÃO do trend atual,
 * não só `acceleration !== 0` -- hipótese v1 simples, documentada como
 * tal (mesmo espírito de qualquer outro limiar aceito no projeto).
 */
function buildFundingAcceleration(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_FUNDING_ACCELERATION, feature: "FundingAcceleration", featureType: "ACCELERATION" });

  const observation = observeFunding(signal);
  let state = "NORMAL";
  let direction = "neutral";
  if (observation.trend == null || observation.acceleration == null) {
    state = "UNKNOWN";
  } else if (observation.trend === "rising" && observation.acceleration > 0) {
    state = "HIGH";
    direction = "above";
  } else if (observation.trend === "falling" && observation.acceleration < 0) {
    state = "HIGH";
    direction = "below";
  }

  return createFeature({
    id: FEATURE_FUNDING_ACCELERATION,
    feature: "FundingAcceleration",
    featureType: "ACCELERATION",
    observation,
    state,
    direction,
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

function buildFundingFeatures(db, symbol) {
  const signal = resolveMetricSignal(db, symbol, "funding");
  return [buildFundingExtreme(signal), buildFundingAcceleration(signal)];
}

module.exports = { buildFundingFeatures, buildFundingExtreme, buildFundingAcceleration };

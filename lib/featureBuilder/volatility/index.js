// Features atômicas sobre a métrica `atr` -- Expansion/Compression já
// vêm prontas de `compressionExpansion` (calculado em
// lib/knowledgeBase/statisticsComputer.js, nunca de `interpretation.level`
// do Resolver). Persistence usa `evidence.persistence` (streak de
// quartis na mesma direção) -- ATR não tem direção própria, então
// `direction` fica sempre "neutral" nas 3 Features aqui.
const { resolveMetricSignal } = require("../../knowledgeBase/statisticalResolver");
const { createFeature, createUnknownFeature } = require("../featureShape");
const { FEATURE_VOLATILITY_EXPANSION, FEATURE_VOLATILITY_COMPRESSION, FEATURE_VOLATILITY_PERSISTENCE } = require("../featureIds");

const PERSISTENCE_THRESHOLD = 3;

function observeVolatility(signal) {
  return {
    value: signal.observation.value,
    zscore: signal.observation.zscore,
    compressionExpansion: signal.observation.compressionExpansion,
    persistence: signal.evidence.persistence,
    resolverInterpretation: signal.interpretation,
  };
}

function buildFromCompressionExpansion(signal, { id, feature, matchValue }) {
  if (!signal) return createUnknownFeature({ id, feature, featureType: matchValue === "expanding" ? "EXPANSION" : "COMPRESSION" });

  const observation = observeVolatility(signal);
  const state = observation.compressionExpansion === matchValue ? "HIGH" : "NORMAL";

  return createFeature({
    id,
    feature,
    featureType: matchValue === "expanding" ? "EXPANSION" : "COMPRESSION",
    observation,
    state,
    direction: "neutral",
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

function buildVolatilityExpansion(signal) {
  return buildFromCompressionExpansion(signal, { id: FEATURE_VOLATILITY_EXPANSION, feature: "VolatilityExpansion", matchValue: "expanding" });
}

function buildVolatilityCompression(signal) {
  return buildFromCompressionExpansion(signal, { id: FEATURE_VOLATILITY_COMPRESSION, feature: "VolatilityCompression", matchValue: "compressing" });
}

/** Limiar simples documentado: 3+ quartis consecutivos na mesma direção conta como "persistente". */
function buildVolatilityPersistence(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_VOLATILITY_PERSISTENCE, feature: "VolatilityPersistence", featureType: "PERSISTENCE" });

  const observation = observeVolatility(signal);
  const state = observation.persistence != null && observation.persistence >= PERSISTENCE_THRESHOLD ? "HIGH" : "NORMAL";

  return createFeature({
    id: FEATURE_VOLATILITY_PERSISTENCE,
    feature: "VolatilityPersistence",
    featureType: "PERSISTENCE",
    observation,
    state,
    direction: "neutral",
    confidence: signal.confidence.value,
    source: "StatisticalResolver",
    resolverVersion: signal.evidence.resolverVersion,
    statisticsVersion: signal.evidence.statisticsVersion,
  });
}

function buildVolatilityFeatures(db, symbol) {
  const signal = resolveMetricSignal(db, symbol, "atr");
  return [buildVolatilityExpansion(signal), buildVolatilityCompression(signal), buildVolatilityPersistence(signal)];
}

module.exports = { buildVolatilityFeatures, buildVolatilityExpansion, buildVolatilityCompression, buildVolatilityPersistence };

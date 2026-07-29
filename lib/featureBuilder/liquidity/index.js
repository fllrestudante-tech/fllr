// Feature atômica sobre a métrica `spread` -- chamada de "SpreadExpansion",
// não "LiquidityImbalance": o dado real disponível hoje é só spread
// (bid/ask de tickers_snapshot), não profundidade de order book.
// "Liquidity Imbalance" de verdade envolveria bid vs. ask, profundidade,
// absorção -- nada disso é coletado ainda. Renomear de volta só quando
// order book real existir.
const { resolveMetricSignal } = require("../../knowledgeBase/statisticalResolver");
const { levelFromPercentile } = require("../levelFromPercentile");
const { createFeature, createUnknownFeature } = require("../featureShape");
const { FEATURE_SPREAD_EXPANSION } = require("../featureIds");

function buildSpreadExpansion(signal) {
  if (!signal) return createUnknownFeature({ id: FEATURE_SPREAD_EXPANSION, feature: "SpreadExpansion", featureType: "EXPANSION" });

  const observation = {
    percentile: signal.observation.percentile,
    zscore: signal.observation.zscore,
    value: signal.observation.value,
    resolverInterpretation: signal.interpretation,
  };
  const { level, direction } = levelFromPercentile(observation.percentile);
  // SpreadExpansion só importa quando o spread está ACIMA do normal
  // (spread caindo não é "expansão") -- HIGH/EXTREME viram NORMAL se a
  // direção for "below".
  const state = direction === "above" ? level : "NORMAL";

  return createFeature({
    id: FEATURE_SPREAD_EXPANSION,
    feature: "SpreadExpansion",
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

function buildLiquidityFeatures(db, symbol) {
  const signal = resolveMetricSignal(db, symbol, "spread");
  return [buildSpreadExpansion(signal)];
}

module.exports = { buildLiquidityFeatures, buildSpreadExpansion };

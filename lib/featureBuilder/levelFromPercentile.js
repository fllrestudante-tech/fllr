// Critério PRÓPRIO do Feature Builder pra bucketizar percentil em nível
// categórico -- deliberadamente independente de
// lib/knowledgeBase/statisticalResolver.js::interpretLevel (mesmo que
// comece com os mesmos números 95/80/20/5). São 2 hipóteses desacopladas:
// o Resolver decide "isso é raro pra ESTA métrica" de forma genérica: o
// Feature Builder decide "essa Feature específica está ativa" com seu
// próprio critério, que pode evoluir sem tocar no Resolver (e vice-versa).
const DEFAULT_THRESHOLDS = { extreme: 95, high: 80, low: 20, extremeLow: 5 };

function levelFromPercentile(percentile, thresholds = DEFAULT_THRESHOLDS) {
  if (percentile == null) return { level: "UNKNOWN", direction: "neutral" };
  if (percentile >= thresholds.extreme) return { level: "EXTREME", direction: "above" };
  if (percentile >= thresholds.high) return { level: "HIGH", direction: "above" };
  if (percentile <= thresholds.extremeLow) return { level: "EXTREME", direction: "below" };
  if (percentile <= thresholds.low) return { level: "LOW", direction: "below" };
  return { level: "NORMAL", direction: "neutral" };
}

module.exports = { levelFromPercentile, DEFAULT_THRESHOLDS };

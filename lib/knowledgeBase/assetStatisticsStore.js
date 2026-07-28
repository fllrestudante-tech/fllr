// Persistência da Asset Statistics -- diferente de lib/knowledgeBase/assetStore.js
// (merge parcial, preserva campo não mencionado), aqui cada upsert é um
// REPLACE COMPLETO: uma rodada de computeAssetStatistics é uma fotografia
// coerente (window + métricas), nunca um patch de 1 campo só.
const METRICS = ["atr", "funding", "openInterest", "volume", "spread"];
const METRIC_DB_NAME = { atr: "atr", funding: "funding", openInterest: "open_interest", volume: "volume", spread: "spread" };

const WINDOW_COLUMNS = [
  "window_candles", "coverage_pct", "freshness_score", "missing_rate", "duplicate_rate", "gap_rate",
  "sample_size", "effective_sample_size", "confidence",
];
const METRIC_COLUMNS = [
  "sample_size", "avg", "median", "stddev", "min", "max",
  "p10", "p25", "p50", "p75", "p90", "p95", "p99",
  "mad", "iqr", "trimmed_mean", "winsorized_mean", "skewness", "kurtosis",
  "current_value", "zscore_current", "percentile_current", "drift_pct",
  "trend", "velocity", "acceleration", "persistence", "compression_expansion",
  "stability_score", "quality", "confidence",
];

function getAssetStatistics(db, symbol, scope = "global", windowDays) {
  const windowRow = db.prepare(`SELECT * FROM asset_statistics_window WHERE symbol = ? AND statistics_scope = ? AND window_days = ?`).get(symbol, scope, windowDays);
  if (!windowRow) return null;

  const metricRows = db.prepare(`SELECT * FROM asset_metric_statistics WHERE symbol = ? AND statistics_scope = ? AND window_days = ?`).all(symbol, scope, windowDays);
  const metrics = {};
  for (const row of metricRows) {
    const field = Object.keys(METRIC_DB_NAME).find((f) => METRIC_DB_NAME[f] === row.metric) || row.metric;
    metrics[field] = row;
  }

  return { window: windowRow, metrics };
}

/**
 * `{ window, metrics }` no mesmo formato que `computeAssetStatistics`
 * devolve pra 1 janela (`result[windowDays]`). Substitui a linha inteira
 * de window + cada linha de métrica -- não preserva valor antigo de
 * nenhum campo, incrementa `version` na tabela de window.
 */
function upsertAssetStatistics(db, symbol, scope, windowDays, { window, metrics }, { now = () => new Date().toISOString() } = {}) {
  const timestamp = now();

  const windowSetClause = WINDOW_COLUMNS.map((c) => `${c} = @${c}`).join(", ");
  const windowParams = { symbol, scope, windowDays, computedAt: window.computedAt || timestamp, updatedAt: timestamp, createdAt: timestamp };
  for (const col of WINDOW_COLUMNS) {
    const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    windowParams[col] = window[camel] != null ? window[camel] : null;
  }

  db.prepare(
    `INSERT INTO asset_statistics_window (symbol, statistics_scope, window_days, ${WINDOW_COLUMNS.join(", ")}, version, computed_at, created_at, updated_at)
     VALUES (@symbol, @scope, @windowDays, ${WINDOW_COLUMNS.map((c) => `@${c}`).join(", ")}, 1, @computedAt, @createdAt, @updatedAt)
     ON CONFLICT(symbol, statistics_scope, window_days) DO UPDATE SET
       ${windowSetClause},
       version = asset_statistics_window.version + 1,
       computed_at = @computedAt,
       updated_at = @updatedAt`
  ).run(windowParams);

  for (const field of METRICS) {
    const metric = metrics[field];
    if (!metric) continue;
    const metricSetClause = METRIC_COLUMNS.map((c) => `${c} = @${c}`).join(", ");
    const metricParams = { symbol, scope, windowDays, metricName: METRIC_DB_NAME[field], createdAt: timestamp, updatedAt: timestamp };
    for (const col of METRIC_COLUMNS) {
      const camel = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      metricParams[col] = metric[camel] != null ? metric[camel] : null;
    }

    db.prepare(
      `INSERT INTO asset_metric_statistics (symbol, statistics_scope, window_days, metric, ${METRIC_COLUMNS.join(", ")}, created_at, updated_at)
       VALUES (@symbol, @scope, @windowDays, @metricName, ${METRIC_COLUMNS.map((c) => `@${c}`).join(", ")}, @createdAt, @updatedAt)
       ON CONFLICT(symbol, statistics_scope, window_days, metric) DO UPDATE SET
         ${metricSetClause},
         updated_at = @updatedAt`
    ).run(metricParams);
  }

  return getAssetStatistics(db, symbol, scope, windowDays);
}

module.exports = { getAssetStatistics, upsertAssetStatistics, METRICS };

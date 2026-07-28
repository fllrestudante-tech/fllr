// Asset Statistics -- computa fatos DERIVADOS por símbolo (nunca
// digitados, sempre calculados a partir de data/market.db real).
// Reaproveita o que já existe: lib/candleHistory.js (candles),
// lib/indicators.js::calcATR (valor canônico de ATR), lib/dataCoverage.js
// (coverage), lib/freshnessScore.js (freshness), lib/temporalGaps.js
// (gaps) -- só a matemática de distribuição (percentis/robustas/forma/
// dinâmica) é lógica nova, em lib/knowledgeBase/statMath.js.
//
// Fase 1 (esta rodada): single-symbol, `statistics_scope` sempre
// "global" (campo pronto pro Regime Engine preencher no futuro, sem
// segmentação implementada). Nada aqui é consumido por nenhum Brain --
// ver lib/knowledgeBase/statisticalResolver.js.
const candleHistory = require("../candleHistory");
const { detectGaps } = require("../temporalGaps");
const { computeCoverage, countRowsInWindow } = require("../dataCoverage");
const { computeFreshnessScore } = require("../freshnessScore");
const { getSla } = require("../slaRegistry");
const { calcATR } = require("../indicators");
const statMath = require("./statMath");
const config = require("../../config");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS_LIST = [7, 30, 90, 180, 365, 730];
const QUALITY_CONFIDENCE = { no_data: 0, low: 40, medium: 70, high: 95 };

function qualityFromSampleSize(sampleSize) {
  if (!sampleSize || sampleSize === 0) return "no_data";
  if (sampleSize < 10) return "low";
  if (sampleSize < 50) return "medium";
  return "high";
}

function sign(value) {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/** True range por candle (série, não só o valor único que calcATR devolve). */
function trueRangeSeries(candlesArrayFormat) {
  const series = [];
  for (let i = 1; i < candlesArrayFormat.length; i++) {
    const [, , high, low] = candlesArrayFormat[i];
    const prevClose = candlesArrayFormat[i - 1][4];
    const value = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    series.push({ t: candlesArrayFormat[i][0], value });
  }
  return series;
}

function sliceSeries(series, sinceMs, untilMs) {
  return series.filter((p) => p.t >= sinceMs && p.t <= untilMs);
}

function quarters(series) {
  const n = series.length;
  const q = Math.floor(n / 4);
  return [series.slice(0, q), series.slice(q, 2 * q), series.slice(2 * q, 3 * q), series.slice(3 * q)];
}

/**
 * Dinâmica de série temporal -- hipóteses de 1ª versão, documentadas
 * como tal (mesmo espírito de RANGING_THRESHOLD_PCT/stabilityScore já
 * aceito em lib/brains/marketBrain.js): trend/velocity/acceleration a
 * partir de médias por quartil do próprio período, persistence = streak
 * de quartis consecutivos na mesma direção (mesma técnica de "contar pra
 * trás" de classifyTrend em marketBrain.js), compressionExpansion
 * compara stddev do quartil mais recente vs. o mais antigo.
 */
function computeDynamics(series, windowDays, overallStddev) {
  const [q1, q2, q3, q4] = quarters(series);
  if (q1.length === 0 || q2.length === 0 || q3.length === 0 || q4.length === 0) {
    return { trend: null, velocity: null, acceleration: null, persistence: null, compressionExpansion: null };
  }
  const quarterDays = windowDays / 4 || 1;
  const meanQ1 = statMath.mean(q1.map((p) => p.value));
  const meanQ2 = statMath.mean(q2.map((p) => p.value));
  const meanQ3 = statMath.mean(q3.map((p) => p.value));
  const meanQ4 = statMath.mean(q4.map((p) => p.value));

  const velocityEarly = (meanQ2 - meanQ1) / quarterDays;
  const velocityLate = (meanQ4 - meanQ3) / quarterDays;
  const velocity = velocityLate;
  const acceleration = velocityLate - velocityEarly;

  const threshold = (overallStddev || 0) * 0.05;
  const trend = velocity > threshold ? "rising" : velocity < -threshold ? "falling" : "flat";

  const deltas = [meanQ2 - meanQ1, meanQ3 - meanQ2, meanQ4 - meanQ3];
  const directions = deltas.map(sign);
  const lastDirection = directions[directions.length - 1];
  let persistence = 0;
  for (let i = directions.length - 1; i >= 0; i--) {
    if (directions[i] !== lastDirection) break;
    persistence++;
  }

  const stddevFirstHalf = statMath.stddev([...q1, ...q2].map((p) => p.value));
  const stddevSecondHalf = statMath.stddev([...q3, ...q4].map((p) => p.value));
  let compressionExpansion = "stable";
  if (stddevFirstHalf && stddevSecondHalf) {
    if (stddevSecondHalf < stddevFirstHalf * 0.8) compressionExpansion = "compressing";
    else if (stddevSecondHalf > stddevFirstHalf * 1.2) compressionExpansion = "expanding";
  }

  return { trend, velocity, acceleration, persistence, compressionExpansion };
}

function rankPercentile(sorted, value) {
  if (sorted.length === 0) return null;
  const countLessEqual = sorted.filter((v) => v <= value).length;
  return (countLessEqual / sorted.length) * 100;
}

/**
 * Estatística completa de UMA métrica, numa janela -- usada igualmente
 * pras 5 métricas (atr/funding/openInterest/volume/spread), evita
 * duplicar a mesma lógica 5 vezes.
 */
function computeMetricStatistics(series, previousWindowSeries, windowDays) {
  const values = series.map((p) => p.value);
  const sampleSize = values.length;
  const quality = qualityFromSampleSize(sampleSize);

  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      avg: null, median: null, stddev: null, min: null, max: null,
      p10: null, p25: null, p50: null, p75: null, p90: null, p95: null, p99: null,
      mad: null, iqr: null, trimmedMean: null, winsorizedMean: null,
      skewness: null, kurtosis: null,
      currentValue: null, zscoreCurrent: null, percentileCurrent: null,
      driftPct: null, trend: null, velocity: null, acceleration: null, persistence: null, compressionExpansion: null,
      stabilityScore: null, quality, confidence: QUALITY_CONFIDENCE[quality],
    };
  }

  const sorted = statMath.sortAsc(values);
  const avg = statMath.mean(values);
  const stddev = statMath.stddev(values);
  const currentValue = series[series.length - 1].value;
  const zscoreCurrent = stddev ? (currentValue - avg) / stddev : null;
  const percentileCurrent = rankPercentile(sorted, currentValue);

  const previousValues = previousWindowSeries.map((p) => p.value);
  const prevAvg = statMath.mean(previousValues);
  const driftPct = prevAvg ? ((avg - prevAvg) / Math.abs(prevAvg)) * 100 : null;

  const dynamics = computeDynamics(series, windowDays, stddev);

  const cv = avg ? Math.abs(stddev / avg) : stddev ? Infinity : 0;
  const stabilityScore = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.min(1, cv)))));

  return {
    sampleSize,
    avg, median: statMath.median(values), stddev, min: sorted[0], max: sorted[sorted.length - 1],
    p10: statMath.percentile(sorted, 10), p25: statMath.percentile(sorted, 25), p50: statMath.percentile(sorted, 50),
    p75: statMath.percentile(sorted, 75), p90: statMath.percentile(sorted, 90), p95: statMath.percentile(sorted, 95),
    p99: statMath.percentile(sorted, 99),
    mad: statMath.mad(values), iqr: statMath.iqr(values), trimmedMean: statMath.trimmedMean(values), winsorizedMean: statMath.winsorizedMean(values),
    skewness: statMath.skewness(values), kurtosis: statMath.kurtosis(values),
    currentValue, zscoreCurrent, percentileCurrent,
    driftPct, ...dynamics,
    stabilityScore, quality, confidence: QUALITY_CONFIDENCE[quality],
  };
}

function queryTimeSeries(db, table, valueColumn, timeColumn, symbol, sinceMs, untilMs) {
  return db
    .prepare(`SELECT ${timeColumn} as t, ${valueColumn} as value FROM ${table} WHERE symbol = ? AND ${timeColumn} BETWEEN ? AND ? ORDER BY ${timeColumn} ASC`)
    .all(symbol, sinceMs, untilMs)
    .map((r) => ({ t: r.t, value: r.value }));
}

function querySpreadSeries(db, symbol, sinceMs, untilMs) {
  return db
    .prepare(`SELECT snapshot_time as t, bid_price as bid, ask_price as ask FROM tickers_snapshot WHERE symbol = ? AND snapshot_time BETWEEN ? AND ? ORDER BY snapshot_time ASC`)
    .all(symbol, sinceMs, untilMs)
    .filter((r) => r.bid != null && r.ask != null && r.ask > r.bid)
    .map((r) => ({ t: r.t, value: ((r.ask - r.bid) / ((r.ask + r.bid) / 2)) * 100 }));
}

function computeWindowQuality(db, symbol, windowDays, now, candleSeries) {
  const windowMs = windowDays * DAY_MS;
  const sla = getSla("candles");
  const expectedCount = Math.round(windowMs / sla.expectedIntervalMs);
  const actualCount = countRowsInWindow(db, "candles", "open_time", windowMs, now);
  const { coveragePct } = computeCoverage(actualCount, expectedCount);

  const timestamps = candleSeries.map((p) => p.t);
  const gaps = timestamps.length > 1 ? detectGaps(timestamps, sla.expectedIntervalMs, config.sla.toleranceMultiplier) : [];
  const gapRate = expectedCount > 0 ? gaps.length / expectedCount : null;

  const latestTimestamp = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
  const freshness = computeFreshnessScore("candles", latestTimestamp, now);

  return {
    windowCandles: actualCount,
    coveragePct,
    freshnessScore: freshness.score,
    missingRate: coveragePct != null ? Math.max(0, 1 - coveragePct / 100) : null,
    duplicateRate: 0, // candles têm unique constraint (exchange,symbol,interval,open_time) -- nunca duplicam na origem
    gapRate,
    sampleSize: actualCount,
    effectiveSampleSize: coveragePct != null ? Math.round(actualCount * (coveragePct / 100)) : actualCount,
  };
}

/**
 * `windowDaysList` computado a partir da MAIOR janela pedida buscada uma
 * única vez por fonte (candles/funding/open_interest/tickers_snapshot),
 * depois fatiada em memória por janela -- evita repetir a mesma query 6x.
 */
function computeAssetStatistics(db, symbol, { scope = "global", windowDaysList = DEFAULT_WINDOW_DAYS_LIST, now = Date.now(), interval = config.interval } = {}) {
  const maxWindowDays = Math.max(...windowDaysList);
  const maxWindowMs = maxWindowDays * DAY_MS;
  const sinceMaxMs = now - 2 * maxWindowMs; // 2x pra ter dado suficiente pra "janela anterior" (drift) da maior janela também

  const candlesResult = candleHistory.getBacktestCandles(db, {
    symbol,
    interval,
    intervalMinutes: Number(interval) || 1,
    lookbackDays: maxWindowDays * 2,
    minCandles: 30,
  });
  const candles = candlesResult ? candlesResult.candles : [];
  const atrSeriesAll = trueRangeSeries(candles);
  const volumeSeriesAll = candles.map((c) => ({ t: c[0], value: c[5] }));
  const fundingSeriesAll = queryTimeSeries(db, "funding", "funding_rate", "funding_time", symbol, sinceMaxMs, now);
  const oiSeriesAll = queryTimeSeries(db, "open_interest", "oi_value", "snapshot_time", symbol, sinceMaxMs, now);
  const spreadSeriesAll = querySpreadSeries(db, symbol, sinceMaxMs, now);

  const result = {};
  for (const windowDays of windowDaysList) {
    const windowMs = windowDays * DAY_MS;
    const sinceMs = now - windowMs;
    const prevSinceMs = now - 2 * windowMs;

    const candleSeriesWindow = sliceSeries(volumeSeriesAll, sinceMs, now);
    const windowQuality = computeWindowQuality(db, symbol, windowDays, now, candleSeriesWindow);

    const metrics = {
      atr: computeMetricStatistics(sliceSeries(atrSeriesAll, sinceMs, now), sliceSeries(atrSeriesAll, prevSinceMs, sinceMs), windowDays),
      funding: computeMetricStatistics(sliceSeries(fundingSeriesAll, sinceMs, now), sliceSeries(fundingSeriesAll, prevSinceMs, sinceMs), windowDays),
      openInterest: computeMetricStatistics(sliceSeries(oiSeriesAll, sinceMs, now), sliceSeries(oiSeriesAll, prevSinceMs, sinceMs), windowDays),
      volume: computeMetricStatistics(candleSeriesWindow, sliceSeries(volumeSeriesAll, prevSinceMs, sinceMs), windowDays),
      spread: computeMetricStatistics(sliceSeries(spreadSeriesAll, sinceMs, now), sliceSeries(spreadSeriesAll, prevSinceMs, sinceMs), windowDays),
    };

    // `avg` do ATR sobrescrito pelo valor canônico de lib/indicators.js::calcATR
    // -- mesmo número que qualquer outro lugar do código reportaria pro
    // mesmo símbolo/janela. O resto (percentis/stddev/robustas/forma/
    // dinâmica) continua vindo da série de true range por candle, já que
    // não existe uma série de ATR pronta no projeto pra derivar distribuição.
    const candlesWindow = candles.filter((c) => c[0] >= sinceMs && c[0] <= now);
    if (candlesWindow.length > 0) {
      metrics.atr.avg = calcATR(candlesWindow, 14);
    }

    const confidence = Math.round((windowQuality.coveragePct || 0) * 0.5 + (windowQuality.freshnessScore || 0) * 0.5);

    result[windowDays] = {
      window: { symbol, scope, windowDays, computedAt: new Date(now).toISOString(), confidence, ...windowQuality },
      metrics,
    };
  }

  return result;
}

module.exports = { computeAssetStatistics, computeMetricStatistics, computeDynamics, trueRangeSeries, rankPercentile, DEFAULT_WINDOW_DAYS_LIST };

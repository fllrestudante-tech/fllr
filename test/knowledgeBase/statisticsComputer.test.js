const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { calcATR } = require("../../lib/indicators");
const statMath = require("../../lib/knowledgeBase/statMath");
const { computeAssetStatistics, computeMetricStatistics, computeDynamics } = require("../../lib/knowledgeBase/statisticsComputer");

function closeTo(actual, expected, epsilon = 1e-6) {
  assert.ok(Math.abs(actual - expected) < epsilon, `esperado ~${expected}, recebido ${actual}`);
}

// -------------------------------------------------------------------------
// Fixture A: matemática direta, sem DB -- série sintética com trend/drift
// calculados à mão (ver raciocínio no plano aprovado).
// -------------------------------------------------------------------------
const RISING_SERIES = [10, 10, 20, 20, 40, 40, 80, 80].map((value, i) => ({ t: i, value }));

test("computeDynamics: série claramente crescente -> trend=rising, velocity/acceleration/persistence calculados à mão", () => {
  const overallStddev = statMath.stddev(RISING_SERIES.map((p) => p.value));
  const dynamics = computeDynamics(RISING_SERIES, 8, overallStddev);

  assert.equal(dynamics.trend, "rising");
  closeTo(dynamics.velocity, 20); // (meanQ4=80 - meanQ3=40) / (8/4)
  closeTo(dynamics.acceleration, 15); // velocityLate(20) - velocityEarly(5)
  assert.equal(dynamics.persistence, 3); // os 3 deltas entre quartis são todos positivos
  assert.equal(dynamics.compressionExpansion, "expanding"); // stddev do 2º semestre >> 1º
});

test("computeMetricStatistics: driftPct/zscore/percentileCurrent calculados à mão sobre a série crescente", () => {
  const previousWindowSeries = [20, 20, 20, 20].map((value, i) => ({ t: i, value }));
  const result = computeMetricStatistics(RISING_SERIES, previousWindowSeries, 8);

  closeTo(result.avg, 37.5);
  closeTo(result.driftPct, 87.5); // ((37.5-20)/20)*100
  assert.equal(result.currentValue, 80);
  assert.equal(result.percentileCurrent, 100); // maior valor da própria amostra
  closeTo(result.zscoreCurrent, (80 - 37.5) / statMath.stddev(RISING_SERIES.map((p) => p.value)));
  assert.equal(result.sampleSize, 8);
  assert.equal(result.quality, "low"); // 8 < 10
});

test("computeMetricStatistics: amostra vazia devolve quality=no_data, tudo null, sem lançar erro", () => {
  const result = computeMetricStatistics([], [], 30);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.quality, "no_data");
  assert.equal(result.confidence, 0);
  assert.equal(result.avg, null);
  assert.equal(result.trend, null);
});

// -------------------------------------------------------------------------
// Fixture B: banco :memory: real, computeAssetStatistics de ponta a ponta.
// -------------------------------------------------------------------------
const SYMBOL = "TESTUSDT";
const INTERVAL = "60"; // candles horárias -- mantém o fixture pequeno (336 linhas pra 14 dias)
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function insertCandle(db, { openTime, open, high, low, close, volume }) {
  db.prepare(
    `INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at)
     VALUES (@uuid, 'bybit', @symbol, @interval, @openTime, @open, @high, @low, @close, @volume, @recordedAt)`
  ).run({ uuid: crypto.randomUUID(), symbol: SYMBOL, interval: INTERVAL, openTime, open, high, low, close, volume, recordedAt: new Date(openTime).toISOString() });
}

function insertFunding(db, { fundingTime, fundingRate }) {
  db.prepare(
    `INSERT INTO funding (uuid, exchange, symbol, funding_rate, funding_time, recorded_at) VALUES (@uuid, 'bybit', @symbol, @fundingRate, @fundingTime, @recordedAt)`
  ).run({ uuid: crypto.randomUUID(), symbol: SYMBOL, fundingRate, fundingTime, recordedAt: new Date(fundingTime).toISOString() });
}

function insertOi(db, { snapshotTime, oiValue }) {
  db.prepare(
    `INSERT INTO open_interest (uuid, exchange, symbol, oi_value, snapshot_time, recorded_at) VALUES (@uuid, 'bybit', @symbol, @oiValue, @snapshotTime, @recordedAt)`
  ).run({ uuid: crypto.randomUUID(), symbol: SYMBOL, oiValue, snapshotTime, recordedAt: new Date(snapshotTime).toISOString() });
}

function buildFixtureDb({ withTickers = false } = {}) {
  const db = new Database(":memory:");
  runMigrations(db);

  // lib/candleHistory.js::getBacktestCandles usa Date.now() internamente
  // (não aceita `now` injetado) -- o fixture precisa usar o relógio real
  // pra ficar dentro da janela que ele de fato consulta.
  const now = Date.now();
  // 14 dias de candles horárias (336 linhas) -- cobre janela de 7 dias + janela anterior de 7 dias (drift)
  let price = 100;
  for (let i = 0; i < 14 * 24; i++) {
    const openTime = now - (14 * 24 - i) * HOUR_MS;
    const high = price + 2;
    const low = price - 2;
    insertCandle(db, { openTime, open: price, high, low, close: price + 0.5, volume: 1000 + i });
    price += 0.1;
  }
  // funding a cada 8h, últimos 14 dias
  for (let i = 0; i < 14 * 3; i++) {
    insertFunding(db, { fundingTime: now - (14 * 3 - i) * 8 * HOUR_MS, fundingRate: 0.0001 * (1 + (i % 5)) });
  }
  // open interest a cada 1h, últimos 14 dias
  for (let i = 0; i < 14 * 24; i++) {
    insertOi(db, { snapshotTime: now - (14 * 24 - i) * HOUR_MS, oiValue: 5_000_000 + i * 1000 });
  }
  if (withTickers) {
    db.prepare(
      `INSERT INTO tickers_snapshot (uuid, exchange, symbol, last_price, mark_price, index_price, bid_price, ask_price, volume_24h, turnover_24h, price_change_24h_pct, funding_rate, open_interest, snapshot_time, recorded_at)
       VALUES (@uuid, 'bybit', @symbol, 100, 100, 100, 99.9, 100.1, 1, 1, 0, 0.0001, 5000000, @snapshotTime, @recordedAt)`
    ).run({ uuid: crypto.randomUUID(), symbol: SYMBOL, snapshotTime: now - HOUR_MS, recordedAt: new Date(now - HOUR_MS).toISOString() });
  }

  return { db, now };
}

test("computeAssetStatistics: avg do ATR bate com calcATR chamado direto sobre a mesma janela", () => {
  const { db, now } = buildFixtureDb();
  const result = computeAssetStatistics(db, SYMBOL, { windowDaysList: [7], now, interval: INTERVAL });

  const window7 = result[7];
  assert.ok(window7.metrics.atr.sampleSize > 0);

  // recomputa o ATR direto pra conferir consistência (mesma janela de 7 dias)
  const sinceMs = now - 7 * DAY_MS;
  const rows = db.prepare(`SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND open_time BETWEEN ? AND ? ORDER BY open_time ASC`).all(SYMBOL, sinceMs, now);
  const candlesArrayFormat = rows.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume]);
  const expectedAtr = calcATR(candlesArrayFormat, 14);

  closeTo(window7.metrics.atr.avg, expectedAtr, 1e-9);
  db.close();
});

test("computeAssetStatistics: sem tickers_snapshot, spread fica inteiramente null com quality no_data", () => {
  const { db, now } = buildFixtureDb({ withTickers: false });
  const result = computeAssetStatistics(db, SYMBOL, { windowDaysList: [7], now, interval: INTERVAL });

  const spread = result[7].metrics.spread;
  assert.equal(spread.sampleSize, 0);
  assert.equal(spread.quality, "no_data");
  assert.equal(spread.avg, null);
  db.close();
});

test("computeAssetStatistics: com tickers_snapshot, spread é computado (mesmo com 1 linha só)", () => {
  const { db, now } = buildFixtureDb({ withTickers: true });
  const result = computeAssetStatistics(db, SYMBOL, { windowDaysList: [7], now, interval: INTERVAL });

  const spread = result[7].metrics.spread;
  assert.equal(spread.sampleSize, 1);
  assert.ok(spread.avg > 0);
  db.close();
});

test("computeAssetStatistics: janela maior que o histórico disponível não quebra, só reporta amostra pequena", () => {
  const { db, now } = buildFixtureDb();
  const result = computeAssetStatistics(db, SYMBOL, { windowDaysList: [730], now, interval: INTERVAL });

  const window730 = result[730];
  assert.ok(window730.metrics.atr.sampleSize > 0, "deveria usar o que existe (14 dias), não travar por faltar 730");
  assert.ok(window730.metrics.atr.sampleSize < 14 * 24, "amostra real é bem menor que o esperado pra 730 dias");
  db.close();
});

test("computeAssetStatistics: múltiplas janelas na mesma chamada, cada uma com sample_size coerente", () => {
  const { db, now } = buildFixtureDb();
  const result = computeAssetStatistics(db, SYMBOL, { windowDaysList: [7, 14], now, interval: INTERVAL });

  assert.ok(result[7].metrics.funding.sampleSize > 0);
  assert.ok(result[14].metrics.funding.sampleSize >= result[7].metrics.funding.sampleSize, "janela maior deveria conter pelo menos a mesma amostra da menor");
  db.close();
});

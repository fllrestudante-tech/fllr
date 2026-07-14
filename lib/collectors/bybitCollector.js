const crypto = require("crypto");

// changes > 0 = a linha era nova (INSERT OR IGNORE não bateu no UNIQUE INDEX)
// -- é isso que torna a coleta idempotente e diz se vale emitir evento.
function insertIfNew(db, sql, params) {
  return db.prepare(sql).run(params).changes > 0;
}

/**
 * Grava o penúltimo candle retornado (o último da lista pode ainda estar em
 * formação) -- só o mais recente CANDLE FECHADO importa pro Market Database.
 */
async function collectCandles(db, eventBus, bybitClient, { exchange = "bybit", symbol, interval }) {
  const candles = await bybitClient.getKlines(symbol, interval, 2);
  if (!candles || candles.length < 2) return { inserted: false };

  const [openTime, open, high, low, close, volume] = candles[candles.length - 2];
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @interval, @openTime, @open, @high, @low, @close, @volume, @recordedAt)`,
    {
      uuid,
      exchange,
      symbol,
      interval,
      openTime,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      recordedAt: new Date().toISOString(),
    }
  );

  if (inserted) eventBus.emit("candle.closed", { uuid, exchange, symbol, interval, openTime });
  return { inserted, openTime };
}

async function collectFunding(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getFundingHistory(symbol, 1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const fundingTime = Number(latest.fundingRateTimestamp);
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO funding (uuid, exchange, symbol, funding_rate, funding_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @fundingRate, @fundingTime, @recordedAt)`,
    { uuid, exchange, symbol, fundingRate: Number(latest.fundingRate), fundingTime, recordedAt: new Date().toISOString() }
  );

  if (inserted) eventBus.emit("funding.updated", { uuid, exchange, symbol, fundingTime });
  return { inserted };
}

async function collectOpenInterest(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getOpenInterest(symbol, "5min", 1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const snapshotTime = Number(latest.timestamp);
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO open_interest (uuid, exchange, symbol, oi_value, snapshot_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @oiValue, @snapshotTime, @recordedAt)`,
    { uuid, exchange, symbol, oiValue: Number(latest.openInterest), snapshotTime, recordedAt: new Date().toISOString() }
  );

  if (inserted) eventBus.emit("oi.updated", { uuid, exchange, symbol, snapshotTime });
  return { inserted };
}

function safe(fn, label) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`⚠️  Collector (${label}) falhou:`, err.message);
    }
  };
}

/**
 * Roda os três coletores em intervalos independentes (candles muda a cada
 * minuto, funding/OI muito mais devagar -- funding real só muda a cada ~8h
 * na Bybit, mas o polling curto não tem custo, INSERT OR IGNORE descarta
 * repetição). Retorna uma função pra parar todos os timers.
 */
function runCollector(db, eventBus, bybitClient, config, intervals = {}) {
  const candlesMs = intervals.candlesMs ?? 60000;
  const fundingMs = intervals.fundingMs ?? 5 * 60000;
  const oiMs = intervals.oiMs ?? 5 * 60000;
  const opts = { exchange: "bybit", symbol: config.symbol, interval: config.interval };

  const tickCandles = safe(() => collectCandles(db, eventBus, bybitClient, opts), "candles");
  const tickFunding = safe(() => collectFunding(db, eventBus, bybitClient, opts), "funding");
  const tickOi = safe(() => collectOpenInterest(db, eventBus, bybitClient, opts), "open_interest");

  tickCandles();
  tickFunding();
  tickOi();

  const timers = [setInterval(tickCandles, candlesMs), setInterval(tickFunding, fundingMs), setInterval(tickOi, oiMs)];
  return () => timers.forEach(clearInterval);
}

module.exports = { collectCandles, collectFunding, collectOpenInterest, runCollector };

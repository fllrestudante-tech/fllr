const crypto = require("crypto");
const { createCollectorMetrics } = require("./collectorMetrics");

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

/**
 * Snapshot de ticker (preço/mark/index/spread/funding/OI num call só) -- o
 * endpoint não devolve timestamp por símbolo, então cada chamada é uma nova
 * observação legítima (sem UNIQUE INDEX de idempotência, ao contrário dos
 * outros -- ver migração 0002).
 */
async function collectTicker(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getTickers(symbol);
  if (!list || list.length === 0) return { inserted: false };

  const t = list[0];
  const uuid = crypto.randomUUID();
  const snapshotTime = Date.now();
  db.prepare(
    `INSERT INTO tickers_snapshot (uuid, exchange, symbol, last_price, mark_price, index_price, bid_price, ask_price, volume_24h, turnover_24h, price_change_24h_pct, funding_rate, open_interest, snapshot_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @lastPrice, @markPrice, @indexPrice, @bidPrice, @askPrice, @volume24h, @turnover24h, @priceChange24hPct, @fundingRate, @openInterest, @snapshotTime, @recordedAt)`
  ).run({
    uuid,
    exchange,
    symbol,
    lastPrice: Number(t.lastPrice),
    markPrice: Number(t.markPrice),
    indexPrice: Number(t.indexPrice),
    bidPrice: Number(t.bid1Price),
    askPrice: Number(t.ask1Price),
    volume24h: Number(t.volume24h),
    turnover24h: Number(t.turnover24h),
    priceChange24hPct: Number(t.price24hPcnt),
    fundingRate: Number(t.fundingRate),
    openInterest: Number(t.openInterest),
    snapshotTime,
    recordedAt: new Date().toISOString(),
  });

  eventBus.emit("ticker.updated", { uuid, exchange, symbol, snapshotTime });
  return { inserted: true };
}

async function collectLongShortRatio(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getLongShortRatio(symbol, "5min", 1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const snapshotTime = Number(latest.timestamp);
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO long_short_ratio (uuid, exchange, symbol, buy_ratio, sell_ratio, snapshot_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @buyRatio, @sellRatio, @snapshotTime, @recordedAt)`,
    { uuid, exchange, symbol, buyRatio: Number(latest.buyRatio), sellRatio: Number(latest.sellRatio), snapshotTime, recordedAt: new Date().toISOString() }
  );

  if (inserted) eventBus.emit("long_short_ratio.updated", { uuid, exchange, symbol, snapshotTime });
  return { inserted };
}

function safe(fn, label, metrics) {
  return async () => {
    const startedAt = Date.now();
    try {
      const result = await fn();
      metrics.recordSuccess(label, { inserted: result?.inserted, latencyMs: Date.now() - startedAt });
    } catch (err) {
      metrics.recordFailure(label, err, { latencyMs: Date.now() - startedAt });
      console.error(`⚠️  Collector (${label}) falhou:`, err.message);
    }
  };
}

/**
 * Roda os cinco coletores em intervalos independentes (candles muda a cada
 * minuto; funding/OI/long-short/ticker bem mais devagar -- polling curto não
 * tem custo real, INSERT OR IGNORE descarta repetição onde há chave natural).
 * Retorna { stop, getMetrics } -- stop pra parar todos os timers,
 * getMetrics pra expor métricas de coleta (heartbeat, health check).
 */
function runCollector(db, eventBus, bybitClient, config, intervals = {}) {
  const candlesMs = intervals.candlesMs ?? 60000;
  const fundingMs = intervals.fundingMs ?? 5 * 60000;
  const oiMs = intervals.oiMs ?? 5 * 60000;
  const tickerMs = intervals.tickerMs ?? 60000;
  const longShortMs = intervals.longShortMs ?? 5 * 60000;
  const opts = { exchange: "bybit", symbol: config.symbol, interval: config.interval };

  const metrics = createCollectorMetrics();

  const tickCandles = safe(() => collectCandles(db, eventBus, bybitClient, opts), "candles", metrics);
  const tickFunding = safe(() => collectFunding(db, eventBus, bybitClient, opts), "funding", metrics);
  const tickOi = safe(() => collectOpenInterest(db, eventBus, bybitClient, opts), "open_interest", metrics);
  const tickTicker = safe(() => collectTicker(db, eventBus, bybitClient, opts), "ticker", metrics);
  const tickLongShort = safe(() => collectLongShortRatio(db, eventBus, bybitClient, opts), "long_short_ratio", metrics);

  tickCandles();
  tickFunding();
  tickOi();
  tickTicker();
  tickLongShort();

  const timers = [
    setInterval(tickCandles, candlesMs),
    setInterval(tickFunding, fundingMs),
    setInterval(tickOi, oiMs),
    setInterval(tickTicker, tickerMs),
    setInterval(tickLongShort, longShortMs),
  ];

  return { stop: () => timers.forEach(clearInterval), getMetrics: metrics.getMetrics };
}

module.exports = {
  collectCandles,
  collectFunding,
  collectOpenInterest,
  collectTicker,
  collectLongShortRatio,
  runCollector,
};

const crypto = require("crypto");
const { createCollectorMetrics } = require("./collectorMetrics");
const { scheduleStaggered } = require("./requestScheduler");
const { getUniverse, parseBaseQuote } = require("../universe");
const { upsertAsset } = require("../knowledgeBase/assetStore");

// changes > 0 = a linha era nova (INSERT OR IGNORE não bateu no UNIQUE INDEX)
// -- é isso que torna a coleta idempotente e diz se vale emitir evento.
function insertIfNew(db, sql, params) {
  return db.prepare(sql).run(params).changes > 0;
}

// Extraído de collectCandles pra ser reusado também pelo backfill
// (lib/backfill.js) -- mesmo INSERT OR IGNORE, sem duplicar SQL entre o
// polling ao vivo (1 candle por vez) e a recuperação de um intervalo inteiro
// perdido durante uma queda de conectividade.
function insertCandleRow(db, { exchange = "bybit", symbol, interval, openTime, open, high, low, close, volume }) {
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
  return { inserted, uuid, openTime };
}

/**
 * Grava o penúltimo candle retornado (o último da lista pode ainda estar em
 * formação) -- só o mais recente CANDLE FECHADO importa pro Market Database.
 */
async function collectCandles(db, eventBus, bybitClient, { exchange = "bybit", symbol, interval }) {
  const candles = await bybitClient.getKlines(symbol, interval, 2);
  if (!candles || candles.length < 2) return { inserted: false };

  const [openTime, open, high, low, close, volume] = candles[candles.length - 2];
  const { inserted, uuid } = insertCandleRow(db, { exchange, symbol, interval, openTime, open, high, low, close, volume });

  if (inserted) eventBus.emit("candle.closed", { uuid, exchange, symbol, interval, openTime });
  return { inserted, openTime };
}

function insertFundingRow(db, { exchange = "bybit", symbol, fundingRate, fundingTime }) {
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO funding (uuid, exchange, symbol, funding_rate, funding_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @fundingRate, @fundingTime, @recordedAt)`,
    { uuid, exchange, symbol, fundingRate: Number(fundingRate), fundingTime, recordedAt: new Date().toISOString() }
  );
  return { inserted, uuid, fundingTime };
}

async function collectFunding(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getFundingHistory(symbol, 1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const fundingTime = Number(latest.fundingRateTimestamp);
  const { inserted, uuid } = insertFundingRow(db, { exchange, symbol, fundingRate: latest.fundingRate, fundingTime });

  if (inserted) eventBus.emit("funding.updated", { uuid, exchange, symbol, fundingTime });
  return { inserted };
}

function insertOpenInterestRow(db, { exchange = "bybit", symbol, oiValue, snapshotTime }) {
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO open_interest (uuid, exchange, symbol, oi_value, snapshot_time, recorded_at)
     VALUES (@uuid, @exchange, @symbol, @oiValue, @snapshotTime, @recordedAt)`,
    { uuid, exchange, symbol, oiValue: Number(oiValue), snapshotTime, recordedAt: new Date().toISOString() }
  );
  return { inserted, uuid, snapshotTime };
}

async function collectOpenInterest(db, eventBus, bybitClient, { exchange = "bybit", symbol }) {
  const list = await bybitClient.getOpenInterest(symbol, "5min", 1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const snapshotTime = Number(latest.timestamp);
  const { inserted, uuid } = insertOpenInterestRow(db, { exchange, symbol, oiValue: latest.openInterest, snapshotTime });

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

// shouldPause() é consultado a cada tick (não só uma vez) -- o Connectivity
// Manager pode mudar de estado entre execuções. Pausar em vez de tentar e
// falhar evita martelar a Bybit (e o log) durante uma queda já detectada.
// `symbol` opcional -- Fase A (expansão multi-asset): quando informado,
// repassa pro collectorMetrics pra rastrear sucesso/falha por símbolo além
// do agregado do domínio.
function safe(fn, label, metrics, shouldPause = () => false, symbol) {
  return async () => {
    if (shouldPause()) {
      metrics.recordPaused(label, { symbol });
      return;
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      metrics.recordSuccess(label, { inserted: result?.inserted, latencyMs: Date.now() - startedAt, symbol });
    } catch (err) {
      metrics.recordFailure(label, err, { latencyMs: Date.now() - startedAt, symbol });
      console.error(`⚠️  Collector (${label}${symbol ? " " + symbol : ""}) falhou:`, err.message);
    }
  };
}

/**
 * Roda os cinco coletores para todo símbolo do Universe (Fase A -- expansão
 * multi-asset; lib/universe.js::getUniverse, cai pra [config.symbol] se
 * MARKET_SYMBOLS não estiver configurado, preservando o comportamento de 1
 * símbolo só de antes). Cada domínio (candles/funding/OI/ticker/long-short)
 * agenda 1 tarefa por símbolo via requestScheduler::scheduleStaggered, que
 * espalha as chamadas ao longo do próprio intervalo do domínio em vez de
 * disparar todas de uma vez -- existe só pra não rajar a API da Bybit com
 * dezenas de símbolos × 5 endpoints simultâneos. Retorna { stop, getMetrics }
 * -- stop pra parar todos os schedulers, getMetrics pra expor métricas de
 * coleta (heartbeat, health check), agora com granularidade por símbolo.
 */
function runCollector(db, eventBus, bybitClient, config, intervals = {}, shouldPause = () => false) {
  const candlesMs = intervals.candlesMs ?? 60000;
  const fundingMs = intervals.fundingMs ?? 5 * 60000;
  const oiMs = intervals.oiMs ?? 5 * 60000;
  const tickerMs = intervals.tickerMs ?? 60000;
  const longShortMs = intervals.longShortMs ?? 5 * 60000;
  const schedulerOpts = intervals.maxConcurrent ? { maxConcurrent: intervals.maxConcurrent } : {};

  // `intervals.symbols` opcional -- override direto pra teste/injeção, sem
  // depender de process.env.MARKET_SYMBOLS. Omitido, usa o Universe real
  // (lib/universe.js::getUniverse), que cai pra [config.symbol] sozinho.
  const symbols = intervals.symbols ?? getUniverse({ fallbackSymbol: config.symbol }).symbols;
  const metrics = createCollectorMetrics();
  const registeredAssets = new Set();

  // Registra a linha em `asset` (migração 0011) na primeira vez que o
  // coletor vê um símbolo -- qualquer domínio pode ganhar a corrida, o Set
  // garante que só acontece uma vez por símbolo. Falha aqui não derruba o
  // tick (fica dentro do try/catch de `safe`), só fica sem asset até a
  // próxima tentativa.
  function ensureAssetRegistered(symbol) {
    if (registeredAssets.has(symbol)) return;
    registeredAssets.add(symbol);
    const { baseAsset, quoteAsset } = parseBaseQuote(symbol);
    upsertAsset(db, symbol, { baseAsset, quoteAsset, category: "crypto", origin: "auto-collector" });
  }

  function buildDomainTasks(label, collectFn) {
    return symbols.map((symbol) => {
      const opts = { exchange: "bybit", symbol, interval: config.interval };
      return safe(
        () => {
          ensureAssetRegistered(symbol);
          return collectFn(db, eventBus, bybitClient, opts);
        },
        label,
        metrics,
        shouldPause,
        symbol
      );
    });
  }

  const schedulersByDomain = {
    candles: scheduleStaggered(buildDomainTasks("candles", collectCandles), candlesMs, schedulerOpts),
    funding: scheduleStaggered(buildDomainTasks("funding", collectFunding), fundingMs, schedulerOpts),
    open_interest: scheduleStaggered(buildDomainTasks("open_interest", collectOpenInterest), oiMs, schedulerOpts),
    ticker: scheduleStaggered(buildDomainTasks("ticker", collectTicker), tickerMs, schedulerOpts),
    long_short_ratio: scheduleStaggered(buildDomainTasks("long_short_ratio", collectLongShortRatio), longShortMs, schedulerOpts),
  };

  // Fase A -- visibilidade de saturação do scheduler (Universe Health /
  // rollout progressivo): quantas requisições estão em voo/na fila por
  // domínio agora, sem precisar de fila persistente pra isso.
  function getSchedulerStats() {
    const stats = {};
    for (const [domain, scheduler] of Object.entries(schedulersByDomain)) {
      stats[domain] = { activeCount: scheduler.limiter.activeCount, queuedCount: scheduler.limiter.queuedCount };
    }
    return stats;
  }

  return {
    stop: () => Object.values(schedulersByDomain).forEach((s) => s.stop()),
    getMetrics: metrics.getMetrics,
    getSchedulerStats,
  };
}

module.exports = {
  collectCandles,
  collectFunding,
  collectOpenInterest,
  collectTicker,
  collectLongShortRatio,
  insertCandleRow,
  insertFundingRow,
  insertOpenInterestRow,
  runCollector,
};

const crypto = require("crypto");
const { createCollectorMetrics } = require("./collectorMetrics");

function insertIfNew(db, sql, params) {
  return db.prepare(sql).run(params).changes > 0;
}

async function collectBtcDominance(db, eventBus, client, { source = "coingecko" } = {}) {
  const data = await client.getGlobalMarketData();
  if (!data || !data.market_cap_percentage || data.market_cap_percentage.btc === undefined) {
    return { inserted: false };
  }

  const snapshotTime = Number(data.updated_at) * 1000; // API devolve segundos
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO btc_dominance (uuid, source, btc_dominance_pct, eth_dominance_pct, total_market_cap_usd, total_volume_24h_usd, market_cap_change_24h_pct, snapshot_time, recorded_at)
     VALUES (@uuid, @source, @btcDominancePct, @ethDominancePct, @totalMarketCapUsd, @totalVolume24hUsd, @marketCapChange24hPct, @snapshotTime, @recordedAt)`,
    {
      uuid,
      source,
      btcDominancePct: Number(data.market_cap_percentage.btc),
      ethDominancePct: data.market_cap_percentage.eth !== undefined ? Number(data.market_cap_percentage.eth) : null,
      totalMarketCapUsd: Number(data.total_market_cap.usd),
      totalVolume24hUsd: Number(data.total_volume.usd),
      marketCapChange24hPct:
        data.market_cap_change_percentage_24h_usd !== undefined ? Number(data.market_cap_change_percentage_24h_usd) : null,
      snapshotTime,
      recordedAt: new Date().toISOString(),
    }
  );

  if (inserted) eventBus.emit("btc_dominance.updated", { uuid, source, btcDominancePct: Number(data.market_cap_percentage.btc), snapshotTime });
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
 * O endpoint da CoinGecko cacheia internamente por alguns minutos, então
 * polling curto não ganha dado novo -- 15min é um intervalo razoável,
 * INSERT OR IGNORE descarta o resto se o cache deles não tiver virado ainda.
 */
function runCollector(db, eventBus, client, options = {}) {
  const intervalMs = options.intervalMs ?? 15 * 60 * 1000;
  const metrics = createCollectorMetrics();

  const tick = safe(() => collectBtcDominance(db, eventBus, client, options), "btc_dominance", metrics);
  tick();
  const timer = setInterval(tick, intervalMs);

  return { stop: () => clearInterval(timer), getMetrics: metrics.getMetrics };
}

module.exports = { collectBtcDominance, runCollector };

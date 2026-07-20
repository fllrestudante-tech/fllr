const crypto = require("crypto");
const { createCollectorMetrics } = require("./collectorMetrics");

function insertIfNew(db, sql, params) {
  return db.prepare(sql).run(params).changes > 0;
}

async function collectFearGreed(db, eventBus, client, { source = "alternative.me" } = {}) {
  const list = await client.getFearGreedIndex(1);
  if (!list || list.length === 0) return { inserted: false };

  const latest = list[0];
  const snapshotTime = Number(latest.timestamp) * 1000; // API devolve segundos, banco usa ms em todo lugar
  const uuid = crypto.randomUUID();
  const inserted = insertIfNew(
    db,
    `INSERT OR IGNORE INTO fear_greed (uuid, source, value, classification, snapshot_time, recorded_at)
     VALUES (@uuid, @source, @value, @classification, @snapshotTime, @recordedAt)`,
    {
      uuid,
      source,
      value: Number(latest.value),
      classification: latest.value_classification,
      snapshotTime,
      recordedAt: new Date().toISOString(),
    }
  );

  if (inserted) eventBus.emit("fear_greed.updated", { uuid, source, value: Number(latest.value), snapshotTime });
  return { inserted };
}

function safe(fn, label, metrics, shouldPause = () => false) {
  return async () => {
    if (shouldPause()) {
      metrics.recordPaused(label);
      return;
    }
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
 * O índice só atualiza ~1x/dia (ver time_until_update na resposta), então o
 * polling padrão é de hora em hora -- suficiente pra não perder a
 * atualização diária, INSERT OR IGNORE descarta as consultas repetidas.
 */
function runCollector(db, eventBus, client, options = {}, shouldPause = () => false) {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  const metrics = createCollectorMetrics();

  const tick = safe(() => collectFearGreed(db, eventBus, client, options), "fear_greed", metrics, shouldPause);
  tick();
  const timer = setInterval(tick, intervalMs);

  return { stop: () => clearInterval(timer), getMetrics: metrics.getMetrics };
}

module.exports = { collectFearGreed, runCollector };

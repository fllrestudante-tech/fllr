const crypto = require("crypto");
const { createCollectorMetrics } = require("../collectorMetrics");
const { getCategoryDefaults, inferMarketScope } = require("./marketEventCategories");

function getExistingEvent(db, provider, sourceEventId) {
  return db.prepare("SELECT * FROM market_events WHERE provider = ? AND source_event_id = ?").get(provider, sourceEventId);
}

function replaceAssets(db, eventId, assets) {
  db.prepare("DELETE FROM market_event_assets WHERE event_id = ?").run(eventId);
  const insert = db.prepare("INSERT INTO market_event_assets (event_id, asset) VALUES (?, ?)");
  for (const asset of assets) insert.run(eventId, asset);
}

function buildRow(provider, normalized, now) {
  const defaults = getCategoryDefaults(normalized.category);
  return {
    provider,
    sourceEventId: normalized.sourceEventId,
    title: normalized.title,
    description: normalized.description || null,
    category: normalized.category,
    severity: defaults.severity,
    marketScope: inferMarketScope(normalized.assets),
    expectedVolatility: defaults.expectedVolatility,
    eventTime: normalized.eventTime,
    impactWindowBeforeMs: defaults.impactWindowBeforeMs,
    impactWindowAfterMs: defaults.impactWindowAfterMs,
    confirmed: normalized.confirmed ? 1 : 0,
    sourceUrl: normalized.sourceUrl || null,
    now,
  };
}

/**
 * Diferente dos outros coletores (INSERT OR IGNORE puro): eventos podem
 * mudar depois de publicados (data reagendada, virar confirmado, etc), então
 * aqui é upsert de verdade -- insere se é novo, atualiza se algo mudou,
 * não toca se está idêntico. updated_at só muda quando há mudança real.
 */
function upsertEvent(db, provider, normalized) {
  if (!normalized.eventTime || !normalized.sourceEventId) {
    return { action: "skipped_invalid" };
  }

  const now = new Date().toISOString();
  const row = buildRow(provider, normalized, now);
  const existing = getExistingEvent(db, provider, normalized.sourceEventId);

  if (!existing) {
    const uuid = crypto.randomUUID();
    const info = db
      .prepare(
        `INSERT INTO market_events (uuid, provider, source_event_id, title, description, category, severity, market_scope, expected_volatility, event_time, impact_window_before_ms, impact_window_after_ms, confirmed, source_url, source_reliability_score, recorded_at, updated_at)
         VALUES (@uuid, @provider, @sourceEventId, @title, @description, @category, @severity, @marketScope, @expectedVolatility, @eventTime, @impactWindowBeforeMs, @impactWindowAfterMs, @confirmed, @sourceUrl, NULL, @now, @now)`
      )
      .run({ ...row, uuid });
    replaceAssets(db, info.lastInsertRowid, normalized.assets);
    return { action: "inserted", eventId: info.lastInsertRowid, uuid };
  }

  const changed =
    existing.title !== row.title ||
    existing.event_time !== row.eventTime ||
    existing.confirmed !== row.confirmed ||
    existing.description !== row.description ||
    existing.source_url !== row.sourceUrl;

  if (!changed) return { action: "unchanged", eventId: existing.id, uuid: existing.uuid };

  db.prepare(
    `UPDATE market_events SET title=@title, description=@description, category=@category, severity=@severity, market_scope=@marketScope, expected_volatility=@expectedVolatility, event_time=@eventTime, impact_window_before_ms=@impactWindowBeforeMs, impact_window_after_ms=@impactWindowAfterMs, confirmed=@confirmed, source_url=@sourceUrl, updated_at=@now WHERE id=@id`
  ).run({ ...row, id: existing.id });
  replaceAssets(db, existing.id, normalized.assets);
  return { action: "updated", eventId: existing.id, uuid: existing.uuid };
}

async function collectFromProvider(db, eventBus, provider, client, metrics, opts = {}, shouldPause = () => false) {
  if (shouldPause()) {
    metrics.recordPaused(provider.name);
    return;
  }
  const startedAt = Date.now();
  try {
    const rawEvents = await provider.fetchRawEvents(client, opts);
    let anyChange = false;

    for (const raw of rawEvents) {
      const normalized = provider.normalize(raw);
      const result = upsertEvent(db, provider.name, normalized);
      if (result.action === "inserted" || result.action === "updated") {
        anyChange = true;
        eventBus.emit(result.action === "inserted" ? "market_event.created" : "market_event.updated", {
          uuid: result.uuid,
          provider: provider.name,
          category: normalized.category,
        });
      }
    }

    metrics.recordSuccess(provider.name, { inserted: anyChange, latencyMs: Date.now() - startedAt });
  } catch (err) {
    metrics.recordFailure(provider.name, err, { latencyMs: Date.now() - startedAt });
    console.error(`⚠️  Provider (${provider.name}) falhou:`, err.message);
  }
}

/**
 * Roda cada provider no seu próprio intervalo (padrão 30min -- calendário
 * de eventos não muda a cada minuto). providers: [{provider, client, intervalMs?}].
 */
function runCollector(db, eventBus, providers, options = {}, shouldPause = () => false) {
  const defaultIntervalMs = options.intervalMs ?? 30 * 60 * 1000;
  const metrics = createCollectorMetrics();

  const timers = providers.map(({ provider, client, intervalMs }) => {
    const tick = () => collectFromProvider(db, eventBus, provider, client, metrics, options, shouldPause);
    tick();
    return setInterval(tick, intervalMs ?? defaultIntervalMs);
  });

  return { stop: () => timers.forEach(clearInterval), getMetrics: metrics.getMetrics };
}

module.exports = { upsertEvent, collectFromProvider, runCollector };

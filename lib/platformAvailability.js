// Disponibilidade da plataforma numa janela (default 30 dias) -- lê
// system_incidents (NETWORK + SYSTEM juntos, é tudo tempo em que algo da
// plataforma ficou fora do ar) e agrega em uptime%/downtime/contagens.
// Não fabrica dado: sem nenhum incidente na janela, availabilityPct é 100
// de verdade (caso real), não uma estimativa.
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function computeAvailability(db, { windowMs = DEFAULT_WINDOW_MS, now = Date.now() } = {}) {
  const sinceIso = new Date(now - windowMs).toISOString();
  const incidents = db.prepare(`SELECT * FROM system_incidents WHERE started_at >= ? ORDER BY started_at ASC`).all(sinceIso);

  const downtimeMs = incidents.reduce((sum, inc) => sum + (inc.duration_ms || 0), 0);
  const unexpectedShutdowns = incidents.filter((inc) => inc.type === "SYSTEM").length;
  const autoRecoveries = incidents.filter((inc) => inc.automatic_recovery === 1).length;
  const availabilityPct = Math.max(0, Math.min(100, ((windowMs - downtimeMs) / windowMs) * 100));

  return {
    windowDays: Math.round(windowMs / (24 * 60 * 60 * 1000)),
    availabilityPct,
    downtimeMs,
    totalIncidents: incidents.length,
    unexpectedShutdowns,
    autoRecoveries,
  };
}

module.exports = { computeAvailability, DEFAULT_WINDOW_MS };

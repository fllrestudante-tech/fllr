// Persistência de incidentes de sistema (migração 0007) -- diferente de
// events_log/alerts_history (append-only), um incidente é um registro
// mutável com início e fim: abre com ended_at NULL, fecha com duration_ms e
// resumo de resync quando a conectividade volta. Responde "quantas quedas
// este mês / quanto tempo offline / quanto perdemos de coleta" sem precisar
// reconstruir isso correlacionando eventos soltos.
const crypto = require("crypto");

function insertOpenIncident(db, { type, severity, rootCause, startedAt }) {
  const uuid = crypto.randomUUID();
  db.prepare(
    `INSERT INTO system_incidents (uuid, type, severity, root_cause, started_at, created_at)
     VALUES (@uuid, @type, @severity, @rootCause, @startedAt, @createdAt)`
  ).run({ uuid, type, severity, rootCause, startedAt: new Date(startedAt).toISOString(), createdAt: new Date().toISOString() });
  return uuid;
}

function closeIncident(db, uuid, { endedAt, durationMs, automaticRecovery = true }) {
  db.prepare(
    `UPDATE system_incidents SET ended_at = @endedAt, duration_ms = @durationMs, automatic_recovery = @automaticRecovery WHERE uuid = @uuid`
  ).run({ uuid, endedAt: new Date(endedAt).toISOString(), durationMs, automaticRecovery: automaticRecovery ? 1 : 0 });
}

function updateResyncStatus(db, uuid, { resyncStatus, resyncDetails }) {
  db.prepare(`UPDATE system_incidents SET resync_status = @resyncStatus, resync_details = @resyncDetails WHERE uuid = @uuid`).run({
    uuid,
    resyncStatus,
    resyncDetails: resyncDetails ? JSON.stringify(resyncDetails) : null,
  });
}

// Cobre o supervisor reiniciar no meio de um incidente ainda aberto --
// connectivityManager.resumeIncident() usa isso pra não "esquecer" o
// incidente em memória e nunca fechar/alertar a resolução dele.
function queryOpenIncident(db, type = "NETWORK") {
  const row = db.prepare(`SELECT * FROM system_incidents WHERE type = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get(type);
  if (!row) return null;
  return { ...row, startedAt: new Date(row.started_at).getTime() };
}

function queryIncidents(db, { since, limit = 100 } = {}) {
  const clauses = [];
  const params = {};
  if (since) {
    clauses.push("started_at >= @since");
    params.since = since;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM system_incidents ${where} ORDER BY started_at DESC LIMIT @limit`).all({ ...params, limit });
}

module.exports = { insertOpenIncident, closeIncident, updateResyncStatus, queryOpenIncident, queryIncidents };

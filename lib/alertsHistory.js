// Histórico de alertas em market.db (migração 0006) -- permite perguntas
// depois como "quantas falhas este mês?" / "qual coletor mais falhou?" /
// "qual API mais instável?", sem depender de vasculhar logs de texto.
const crypto = require("crypto");

function insertAlertHistory(db, { severity, source, message, count = 1, occurredAt = new Date().toISOString() }) {
  db.prepare(
    "INSERT INTO alerts_history (uuid, severity, source, message, count, occurred_at) VALUES (@uuid, @severity, @source, @message, @count, @occurredAt)"
  ).run({ uuid: crypto.randomUUID(), severity, source, message, count, occurredAt });
}

/**
 * Consulta simples pra estatísticas -- since/source/severity são filtros
 * opcionais (undefined = sem filtro nessa dimensão).
 */
function queryAlertsHistory(db, { since, source, severity, limit = 100 } = {}) {
  const clauses = [];
  const params = {};
  if (since) {
    clauses.push("occurred_at >= @since");
    params.since = since;
  }
  if (source) {
    clauses.push("source = @source");
    params.source = source;
  }
  if (severity) {
    clauses.push("severity = @severity");
    params.severity = severity;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM alerts_history ${where} ORDER BY occurred_at DESC LIMIT @limit`).all({ ...params, limit });
}

module.exports = { insertAlertHistory, queryAlertsHistory };

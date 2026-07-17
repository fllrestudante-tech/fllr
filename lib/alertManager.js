// Orquestra deduplicação (lib/alertAggregator.js) + severidade
// (lib/alertSeverity.js) + envio (lib/alerts.js::sendTelegramAlert) +
// histórico (lib/alertsHistory.js) num único ponto de entrada. Quem dispara
// um alerta (scripts/supervisor.js num crash, scripts/metricsSampler.js numa
// degradação de freshness/integridade) só chama fire(key, severity, message)
// -- toda a lógica de "manda na hora ou só conta" fica escondida aqui.
const { createAlertAggregator } = require("./alertAggregator");
const { sendTelegramAlert } = require("./alerts");
const { SEVERITY_EMOJI } = require("./alertSeverity");
const { insertAlertHistory } = require("./alertsHistory");

function formatMessage(severity, message) {
  return `${SEVERITY_EMOJI[severity] || "❔"} [${severity}] ${message}`;
}

function formatSummaryMessage(severity, message, count, windowMs) {
  const minutes = Math.round(windowMs / 60000);
  return `${SEVERITY_EMOJI[severity] || "❔"} [${severity}] ${message} -- ${count} vezes nos últimos ${minutes}min`;
}

/**
 * `db` é opcional -- se não for passado, o alertManager ainda funciona
 * (manda pro Telegram, se configurado), só não grava histórico. Isso deixa
 * scripts sem conexão de banco (nenhum hoje, mas por precaução) usarem isto
 * sem quebrar.
 */
function createAlertManager({ windowMs = 15 * 60 * 1000, now = Date.now, sender = sendTelegramAlert, db = null } = {}) {
  const aggregator = createAlertAggregator({ windowMs, now });

  async function fire(key, severity, message) {
    const result = aggregator.record(key, message, severity);
    if (result.action === "send") {
      await sender(formatMessage(severity, message));
      if (db) {
        insertAlertHistory(db, { severity, source: key, message, count: 1, occurredAt: new Date(now()).toISOString() });
      }
    }
    return result;
  }

  async function flush() {
    const expired = aggregator.flushExpired();
    for (const e of expired) {
      await sender(formatSummaryMessage(e.severity, e.message, e.count, windowMs));
      if (db) {
        insertAlertHistory(db, { severity: e.severity, source: e.key, message: e.message, count: e.count, occurredAt: new Date(now()).toISOString() });
      }
    }
    return expired;
  }

  return { fire, flush };
}

module.exports = { createAlertManager, formatMessage, formatSummaryMessage };

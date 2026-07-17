// Vocabulário de severidade dos alertas -- nem todo alerta pesa igual
// ("Fear & Greed atualizado" != "market.db corrompido"). Só constantes, sem
// lógica -- lib/alertManager.js decide qual severidade usar em cada gatilho.
const SEVERITY = ["INFO", "WARNING", "ERROR", "CRITICAL"];

const SEVERITY_EMOJI = {
  INFO: "ℹ️",
  WARNING: "⚠️",
  ERROR: "🔴",
  CRITICAL: "🚨",
};

module.exports = { SEVERITY, SEVERITY_EMOJI };

/**
 * Métricas de coleta por domínio (candles/funding/open_interest/... de
 * qualquer coletor, não só Bybit) -- runs, quantos de fato inseriram dado
 * novo vs. foram pulados por já existir, erros, falhas consecutivas,
 * latência da última chamada. É a base que alimenta tanto o health check
 * (lib/healthChecks.js) quanto, mais pra frente, o Data Quality Score por
 * fonte (Source Reliability Engine, ainda não implementado).
 */
function createCollectorMetrics() {
  const domains = {};

  function ensure(domain) {
    if (!domains[domain]) {
      domains[domain] = {
        totalRuns: 0,
        totalInserted: 0,
        totalSkipped: 0,
        totalErrors: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastLatencyMs: null,
        lastError: null,
      };
    }
    return domains[domain];
  }

  function recordSuccess(domain, { inserted = false, latencyMs = null } = {}) {
    const m = ensure(domain);
    m.totalRuns++;
    if (inserted) m.totalInserted++;
    else m.totalSkipped++;
    m.consecutiveFailures = 0;
    m.lastRunAt = new Date().toISOString();
    m.lastSuccessAt = m.lastRunAt;
    m.lastLatencyMs = latencyMs;
    m.lastError = null;
  }

  function recordFailure(domain, err, { latencyMs = null } = {}) {
    const m = ensure(domain);
    m.totalRuns++;
    m.totalErrors++;
    m.consecutiveFailures++;
    m.lastRunAt = new Date().toISOString();
    m.lastLatencyMs = latencyMs;
    m.lastError = err.message;
  }

  // cópia rasa via JSON -- evita que quem chama getMetrics() mute o estado interno sem querer
  function getMetrics() {
    return JSON.parse(JSON.stringify(domains));
  }

  return { recordSuccess, recordFailure, getMetrics };
}

module.exports = { createCollectorMetrics };

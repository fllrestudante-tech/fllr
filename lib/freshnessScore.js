// Freshness Score: 0-100, baseado em quão recente é a última coleta bem
// sucedida vs. o SLA esperado do domínio (lib/slaRegistry.js). 100 enquanto
// a idade está dentro do intervalo esperado ("fresh"); decai linearmente até
// 0 na zona de tolerância ("late"); 0 fixo depois disso ("stale"). Diferente
// do Collector Lag (lib/slaRegistry.js::computeLag), que compara contra o
// horário esperado da PRÓXIMA coleta -- Freshness só responde "isso é
// recente o bastante?".
const { getSla } = require("./slaRegistry");

function computeFreshnessScore(domain, lastSuccessAt, now = Date.now()) {
  const sla = getSla(domain);

  if (!lastSuccessAt) {
    return { domain, score: 0, ageMs: null, expectedIntervalMs: sla.expectedIntervalMs, state: "never_succeeded" };
  }

  const ageMs = now - new Date(lastSuccessAt).getTime();
  const toleranceMs = sla.expectedIntervalMs * sla.toleranceMultiplier;

  if (ageMs <= sla.expectedIntervalMs) {
    return { domain, score: 100, ageMs, expectedIntervalMs: sla.expectedIntervalMs, state: "fresh" };
  }
  if (ageMs >= toleranceMs) {
    return { domain, score: 0, ageMs, expectedIntervalMs: sla.expectedIntervalMs, state: "stale" };
  }

  // decaimento linear entre expectedIntervalMs (score 100) e toleranceMs (score 0)
  const decayRange = toleranceMs - sla.expectedIntervalMs;
  const decayProgress = (ageMs - sla.expectedIntervalMs) / decayRange;
  const score = Math.round(100 * (1 - decayProgress));
  return { domain, score, ageMs, expectedIntervalMs: sla.expectedIntervalMs, state: "late" };
}

/**
 * Aplica computeFreshnessScore em cada domínio de um objeto no formato que
 * collectorMetrics.getMetrics() já produz (`{ [domain]: { lastSuccessAt, ... } }`).
 */
function computeFreshnessForDomains(domainsMetrics, now = Date.now()) {
  const result = {};
  for (const [domain, m] of Object.entries(domainsMetrics)) {
    result[domain] = computeFreshnessScore(domain, m.lastSuccessAt, now);
  }
  return result;
}

module.exports = { computeFreshnessScore, computeFreshnessForDomains };

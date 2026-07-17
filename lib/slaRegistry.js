// Lógica pura sobre o SLA Registry (config.sla) -- nenhum fs, nenhuma rede.
// getSla resolve o SLA de um domínio (com fallback pro default, cobrindo
// providers novos do Knowledge Collector automaticamente); computeLag é o
// "Collector Lag" pedido: horário ESPERADO da próxima coleta (última coleta
// bem-sucedida + intervalo esperado) vs. agora -- diferente de só reportar
// "há quanto tempo" (isso é Freshness, lib/freshnessScore.js).
const config = require("../config");

function getSla(domain) {
  const cfg = config.sla.domains[domain];
  if (cfg) {
    return {
      domain,
      expectedIntervalMs: cfg.expectedIntervalMs,
      provider: cfg.provider,
      toleranceMultiplier: config.sla.toleranceMultiplier,
    };
  }
  return {
    domain,
    expectedIntervalMs: config.sla.defaultExpectedIntervalMs,
    provider: null,
    toleranceMultiplier: config.sla.toleranceMultiplier,
  };
}

function computeExpectedNextAt(lastSuccessAt, domain) {
  if (!lastSuccessAt) return null;
  const { expectedIntervalMs } = getSla(domain);
  return new Date(new Date(lastSuccessAt).getTime() + expectedIntervalMs).toISOString();
}

/**
 * lagMs positivo = coleta atrasada além do esperado; negativo/zero = dentro
 * do prazo (a próxima coleta ainda nem era esperada). `lastSuccessAt: null`
 * (nunca teve sucesso) retorna tudo null -- não dá pra calcular lag de algo
 * que nunca aconteceu.
 */
function computeLag(domain, lastSuccessAt, now = Date.now()) {
  const sla = getSla(domain);
  if (!lastSuccessAt) {
    return { domain, expectedNextAt: null, lagMs: null, isLate: null };
  }
  const expectedNextMs = new Date(lastSuccessAt).getTime() + sla.expectedIntervalMs;
  const lagMs = now - expectedNextMs;
  return {
    domain,
    expectedNextAt: new Date(expectedNextMs).toISOString(),
    lagMs,
    isLate: lagMs > 0,
  };
}

module.exports = { getSla, computeExpectedNextAt, computeLag };

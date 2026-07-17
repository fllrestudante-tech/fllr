// API Health: score por domínio a partir da janela recente (lib/throughput's
// lastWindow, já calculada por collectorMetrics.js), agregado por provider
// externo (CoinGecko, Bybit, FearGreed, CoinMarketCal, ...) via
// config.sla.domains[domain].provider (lib/slaRegistry.js::getSla).
const { getSla } = require("./slaRegistry");

/**
 * Usa lastWindow (janela FECHADA, não a aberta) -- taxa de erro recente, não
 * desde o boot do processo (isso já existe como totalErrors/totalRuns, mas
 * mistura um erro de dias atrás com o presente). Sem janela fechada ainda,
 * não dá pra reportar uma taxa de verdade.
 */
function computeApiHealthScore(domainMetrics) {
  if (!domainMetrics.lastWindow) {
    return { score: null, reason: "janela ainda não fechou -- sem dado de taxa de erro recente" };
  }
  const { runs, errors } = domainMetrics.lastWindow;
  if (runs === 0) {
    return { score: null, reason: "nenhuma execução na última janela" };
  }
  const errorRate = errors / runs;
  const score = Math.round((1 - errorRate) * 1000) / 10; // 1 casa decimal, ex: 99.8
  return { score, errorRate, runs, errors, consecutiveFailures: domainMetrics.consecutiveFailures };
}

/**
 * Agrega por provider (um provider pode ter vários domínios -- ex: Bybit tem
 * candles/funding/OI/ticker/long_short_ratio). Usa o MÍNIMO dos domínios do
 * provider, não a média -- conservador de propósito: um domínio ruim não
 * deveria se esconder atrás da média dos outros que estão bem.
 */
function aggregateProviderHealth(apiHealthByDomain) {
  const byProvider = {};
  for (const [domain, health] of Object.entries(apiHealthByDomain)) {
    const provider = getSla(domain).provider || domain;
    (byProvider[provider] = byProvider[provider] || []).push(health);
  }

  const result = {};
  for (const [provider, healths] of Object.entries(byProvider)) {
    const scored = healths.filter((h) => h.score !== null);
    result[provider] = scored.length > 0 ? Math.min(...scored.map((h) => h.score)) : null;
  }
  return result;
}

module.exports = { computeApiHealthScore, aggregateProviderHealth };

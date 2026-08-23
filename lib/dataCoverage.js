// Data Coverage Score: "estamos coletando tudo que deveríamos?" (diferente
// do Freshness Score, que só responde "é recente?"). Escopo: só os domínios
// de amostragem periódica (candles/funding/open_interest/ticker/
// long_short_ratio/fear_greed/btc_dominance) -- os domínios baseados em
// market_events (coinmarketcal/fred/fomc_calendar) são orientados a evento,
// não a intervalo, "cobertura" não é um conceito que se aplica a eles do
// mesmo jeito, então ficam de fora aqui (não fabricar um número sem sentido).
const config = require("../config");

const DOMAIN_TABLES = {
  candles: { table: "candles", timeColumn: "open_time" },
  funding: { table: "funding", timeColumn: "funding_time" },
  open_interest: { table: "open_interest", timeColumn: "snapshot_time" },
  ticker: { table: "tickers_snapshot", timeColumn: "snapshot_time" },
  long_short_ratio: { table: "long_short_ratio", timeColumn: "snapshot_time" },
  fear_greed: { table: "fear_greed", timeColumn: "snapshot_time" },
  btc_dominance: { table: "btc_dominance", timeColumn: "snapshot_time" },
};

/**
 * Janela de amostra derivada do próprio intervalo esperado (SLA Registry),
 * não hardcoded por domínio -- pelo menos 20 ocorrências esperadas, ou 1h,
 * o que for maior. Pra um domínio diário (Fear&Greed) isso vira ~20 dias;
 * pra um de 1min (candles) vira 1h (60 ocorrências).
 */
function coverageWindowMs(expectedIntervalMs, minOccurrences = 20, minWindowMs = 60 * 60 * 1000) {
  return Math.max(expectedIntervalMs * minOccurrences, minWindowMs);
}

function computeCoverage(actualCount, expectedCount) {
  if (!expectedCount || expectedCount <= 0) {
    return { coveragePct: null, actualCount, expectedCount, reason: "expectedCount inválido" };
  }
  return { coveragePct: Math.min(100, Math.round((actualCount / expectedCount) * 1000) / 10), actualCount, expectedCount };
}

// `symbol` opcional -- Fase A (expansão multi-asset): quando informado,
// escopa a contagem a 1 símbolo (tabela precisa ter coluna `symbol`, o que
// vale pra candles/funding/open_interest/tickers_snapshot/long_short_ratio,
// não pra fear_greed/btc_dominance -- responsabilidade de quem chama só
// passar symbol pros domínios certos). Omitido, comportamento agregado
// (todos os símbolos juntos) é preservado exatamente como antes.
function countRowsInWindow(db, table, timeColumn, windowMs, now = Date.now(), symbol) {
  const since = now - windowMs;
  const sql = symbol
    ? `SELECT COUNT(*) as c FROM ${table} WHERE ${timeColumn} >= ? AND symbol = ?`
    : `SELECT COUNT(*) as c FROM ${table} WHERE ${timeColumn} >= ?`;
  const row = symbol ? db.prepare(sql).get(since, symbol) : db.prepare(sql).get(since);
  return row.c;
}

/**
 * `dbPath`/injeção de `db` aberto -- mesma flexibilidade de sampleDatabaseHealth
 * (permite abrir read-only e fechar fora, ou reusar uma conexão já aberta).
 */
function sampleCoverage(domain, db, { now = Date.now(), symbol } = {}) {
  const mapping = DOMAIN_TABLES[domain];
  if (!mapping) {
    return { domain, coveragePct: null, reason: "domínio orientado a evento, cobertura não se aplica" };
  }
  const sla = config.sla.domains[domain] || { expectedIntervalMs: config.sla.defaultExpectedIntervalMs };
  const windowMs = coverageWindowMs(sla.expectedIntervalMs);
  const expectedCount = Math.round(windowMs / sla.expectedIntervalMs);
  const actualCount = countRowsInWindow(db, mapping.table, mapping.timeColumn, windowMs, now, symbol);
  return { domain, windowMs, ...computeCoverage(actualCount, expectedCount) };
}

module.exports = { DOMAIN_TABLES, coverageWindowMs, computeCoverage, countRowsInWindow, sampleCoverage };

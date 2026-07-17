// Detecção de lacunas temporais: mesmo com coverage ok em média, pode
// existir um buraco concentrado (ex: coletor ficou 40min fora do ar no meio
// da noite) que uma contagem agregada não pega sozinha. Reusa o mesmo
// DOMAIN_TABLES de lib/dataCoverage.js -- só domínios de amostragem
// periódica têm "gap" como conceito válido.
const { DOMAIN_TABLES } = require("./dataCoverage");

/**
 * timestampsMsSorted precisa estar em ordem crescente. Um gap é um intervalo
 * entre duas leituras consecutivas maior que `expectedIntervalMs *
 * toleranceMultiplier` -- mesma tolerância já usada no Freshness Score, pra
 * manter a mesma régua de "o que conta como atraso" em todo o Market
 * Quality Engine.
 */
function detectGaps(timestampsMsSorted, expectedIntervalMs, toleranceMultiplier = 2) {
  const thresholdMs = expectedIntervalMs * toleranceMultiplier;
  const gaps = [];
  for (let i = 1; i < timestampsMsSorted.length; i++) {
    const deltaMs = timestampsMsSorted[i] - timestampsMsSorted[i - 1];
    if (deltaMs > thresholdMs) {
      gaps.push({ fromMs: timestampsMsSorted[i - 1], toMs: timestampsMsSorted[i], gapMs: deltaMs });
    }
  }
  return gaps;
}

function queryRecentTimestamps(db, table, timeColumn, windowMs, now = Date.now()) {
  const since = now - windowMs;
  return db
    .prepare(`SELECT ${timeColumn} as t FROM ${table} WHERE ${timeColumn} >= ? ORDER BY ${timeColumn} ASC`)
    .all(since)
    .map((r) => r.t);
}

function sampleGaps(domain, db, { windowMs, expectedIntervalMs, toleranceMultiplier = 2, now = Date.now() }) {
  const mapping = DOMAIN_TABLES[domain];
  if (!mapping) {
    return { domain, gaps: null, reason: "domínio orientado a evento, gap temporal não se aplica" };
  }
  const timestamps = queryRecentTimestamps(db, mapping.table, mapping.timeColumn, windowMs, now);
  const gaps = detectGaps(timestamps, expectedIntervalMs, toleranceMultiplier);
  return { domain, sampleSize: timestamps.length, gapsCount: gaps.length, gaps };
}

module.exports = { detectGaps, queryRecentTimestamps, sampleGaps };

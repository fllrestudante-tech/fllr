// Sanity checks: dado pode estar "fresco" e "completo" e ainda assim ser
// LIXO -- vela com high < low, volume negativo, timestamps fora de ordem.
// Cada check é puro (opera sobre arrays já lidos), a consulta ao banco fica
// isolada em funções `query*` à parte, mesmo padrão de lib/temporalGaps.js.
const { queryRecentTimestamps } = require("./temporalGaps");
const { DOMAIN_TABLES } = require("./dataCoverage");

function checkOhlcValidity(candleRows) {
  const violations = candleRows.filter((r) => {
    const validRange = r.high >= r.low;
    const closeInRange = r.close <= r.high && r.close >= r.low;
    const openInRange = r.open <= r.high && r.open >= r.low;
    const volumeOk = r.volume >= 0;
    return !(validRange && closeInRange && openInRange && volumeOk);
  });
  return { checked: candleRows.length, violations: violations.length, violationRows: violations.slice(0, 5), pass: violations.length === 0 };
}

function checkMonotonicTimestamps(timestampsMsSorted) {
  let outOfOrder = 0;
  for (let i = 1; i < timestampsMsSorted.length; i++) {
    if (timestampsMsSorted[i] < timestampsMsSorted[i - 1]) outOfOrder++;
  }
  return { checked: timestampsMsSorted.length, outOfOrder, pass: outOfOrder === 0 };
}

function checkDuplicateTimestamps(timestampsMs) {
  const seen = new Set();
  let duplicates = 0;
  for (const t of timestampsMs) {
    if (seen.has(t)) duplicates++;
    else seen.add(t);
  }
  return { checked: timestampsMs.length, duplicates, pass: duplicates === 0 };
}

// `symbol` opcional -- mesma regra de lib/dataCoverage.js/lib/temporalGaps.js
// (escopa a 1 símbolo quando informado, agregado de todos quando omitido).
function queryRecentCandleRows(db, windowMs, now = Date.now(), symbol) {
  const since = now - windowMs;
  const sql = symbol
    ? "SELECT open, high, low, close, volume FROM candles WHERE open_time >= ? AND symbol = ? ORDER BY open_time ASC"
    : "SELECT open, high, low, close, volume FROM candles WHERE open_time >= ? ORDER BY open_time ASC";
  return symbol ? db.prepare(sql).all(since, symbol) : db.prepare(sql).all(since);
}

/**
 * OHLC validity só existe pra candles (é o único domínio com esse formato).
 * Monotonicidade/duplicação valem pra qualquer domínio de amostragem
 * periódica -- reusa o mesmo DOMAIN_TABLES já usado em coverage/gaps.
 */
function sampleSanityChecks(domain, db, { windowMs, now = Date.now(), symbol }) {
  const mapping = DOMAIN_TABLES[domain];
  if (!mapping) {
    return { domain, checks: null, reason: "domínio orientado a evento, sanity check de série temporal não se aplica" };
  }

  const timestamps = queryRecentTimestamps(db, mapping.table, mapping.timeColumn, windowMs, now, symbol);
  const checks = {
    monotonic: checkMonotonicTimestamps(timestamps),
    duplicates: checkDuplicateTimestamps(timestamps),
  };
  if (domain === "candles") {
    checks.ohlc = checkOhlcValidity(queryRecentCandleRows(db, windowMs, now, symbol));
  }

  const allChecks = Object.values(checks);
  const passRate = allChecks.length > 0 ? Math.round((allChecks.filter((c) => c.pass).length / allChecks.length) * 100) : null;
  return { domain, checks, passRate };
}

module.exports = { checkOhlcValidity, checkMonotonicTimestamps, checkDuplicateTimestamps, queryRecentCandleRows, sampleSanityChecks };

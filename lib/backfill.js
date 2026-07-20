// Recupera dados perdidos durante uma queda de conectividade -- disparado
// pelo Connectivity Manager (scripts/supervisor.js) na transição
// offline->online, usando a janela [incident.startedAt, incident.endedAt].
// Só candles/funding/open_interest (os domínios que a Fase C.1 cobre); BTC
// Dominance fica de fora (é um valor "atual" da CoinGecko, não série
// histórica -- não existe "backfill" que faça sentido pra esse domínio).
const { insertCandleRow, insertFundingRow, insertOpenInterestRow } = require("./collectors/bybitCollector");

const DEFAULT_PAGE_SIZE = 200; // limite mais conservador entre os 3 endpoints (funding/OI capam em 200; kline aceita até 1000)
const DEFAULT_MAX_ITERATIONS = 500; // guarda contra loop infinito -- ver getTimestamp abaixo

/**
 * Pagina [sinceMs, untilMs) chamando fetchRange({start,end,limit}) e
 * inserindo cada linha via insertRow (mesmo INSERT OR IGNORE do coletor ao
 * vivo -- idempotente, seguro rodar de novo ou em paralelo com o polling
 * normal). getTimestamp(row) extrai o timestamp de cada linha pra avançar o
 * cursor pelo MAIOR timestamp visto na página (não pela ordem/posição), o
 * que funciona independente da API devolver ascendente ou descendente.
 * Se uma página não avança o cursor (ex: API sempre devolve "mais recentes"
 * ignorando start/end), para em vez de repetir pra sempre.
 */
async function backfillDomain(db, eventBus, { domain, fetchRange, insertRow, getTimestamp, sinceMs, untilMs, pageSize = DEFAULT_PAGE_SIZE, maxIterations = DEFAULT_MAX_ITERATIONS }) {
  let cursor = sinceMs;
  let inserted = 0;
  let iterations = 0;

  while (cursor < untilMs) {
    iterations++;
    if (iterations > maxIterations) break;

    const rows = await fetchRange({ start: cursor, end: untilMs, limit: pageSize });
    if (!rows || rows.length === 0) break;

    let maxTimestamp = cursor;
    for (const row of rows) {
      const { inserted: wasInserted } = insertRow(row);
      if (wasInserted) inserted++;
      const ts = getTimestamp(row);
      if (ts > maxTimestamp) maxTimestamp = ts;
    }

    if (maxTimestamp <= cursor) break;
    cursor = maxTimestamp + 1;
  }

  if (inserted > 0) eventBus.emit("backfill.completed", { domain, inserted, sinceMs, untilMs });
  return { inserted };
}

async function backfillCandles(db, eventBus, bybitClient, { exchange = "bybit", symbol, interval, sinceMs, untilMs }) {
  return backfillDomain(db, eventBus, {
    domain: "candles",
    sinceMs,
    untilMs,
    fetchRange: ({ start, end, limit }) =>
      bybitClient
        .getKlines(symbol, interval, limit, { start, end })
        .then((rows) => rows.map(([openTime, open, high, low, close, volume]) => ({ openTime, open, high, low, close, volume }))),
    insertRow: (row) => insertCandleRow(db, { exchange, symbol, interval, ...row }),
    getTimestamp: (row) => row.openTime,
  });
}

async function backfillFunding(db, eventBus, bybitClient, { exchange = "bybit", symbol, sinceMs, untilMs }) {
  return backfillDomain(db, eventBus, {
    domain: "funding",
    sinceMs,
    untilMs,
    fetchRange: ({ start, end, limit }) => bybitClient.getFundingHistory(symbol, limit, { start, end }),
    insertRow: (row) => insertFundingRow(db, { exchange, symbol, fundingRate: row.fundingRate, fundingTime: Number(row.fundingRateTimestamp) }),
    getTimestamp: (row) => Number(row.fundingRateTimestamp),
  });
}

async function backfillOpenInterest(db, eventBus, bybitClient, { exchange = "bybit", symbol, intervalTime = "5min", sinceMs, untilMs }) {
  return backfillDomain(db, eventBus, {
    domain: "open_interest",
    sinceMs,
    untilMs,
    fetchRange: ({ start, end, limit }) => bybitClient.getOpenInterest(symbol, intervalTime, limit, { start, end }),
    insertRow: (row) => insertOpenInterestRow(db, { exchange, symbol, oiValue: row.openInterest, snapshotTime: Number(row.timestamp) }),
    getTimestamp: (row) => Number(row.timestamp),
  });
}

module.exports = { backfillDomain, backfillCandles, backfillFunding, backfillOpenInterest };

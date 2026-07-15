// Provider do CoinMarketCal -- eventos específicos de cripto (ETF, hard
// fork, listing, unlock, governança, parceria, etc). Precisa de
// COINMARKETCAL_API_KEY no .env (cadastro grátis em coinmarketcal.com/en/api).
//
// Validado contra resposta real da API v2 (plano grátis) em 2026-07-15: o
// payload NÃO inclui um campo `categories` (nem em endpoints/params testados
// com showViews/showVotes) -- por isso todo evento cai em category="other"
// por ora. `sourceUrl` é o nome de campo real (não `source`/`proof`, que não
// existem na resposta). Revisitar se o plano pago da CoinMarketCal expuser
// categorias.
const CATEGORY_MAP = {
  etf: "etf",
  "hard fork": "hard_fork",
  hardfork: "hard_fork",
  mainnet: "hard_fork",
  listing: "listing",
  delisting: "delisting",
  burn: "burn",
  "token burn": "burn",
  airdrop: "airdrop",
  partnership: "partnership",
  ama: "ama",
  conference: "ama",
  governance: "governance",
  unlock: "unlock",
  vesting: "unlock",
};

function mapCategory(rawCategoryText) {
  const lower = (rawCategoryText || "").toLowerCase();
  for (const [key, value] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return value;
  }
  return "other";
}

async function fetchRawEvents(client, opts = {}) {
  const events = await client.getEvents({ page: opts.page ?? 1, max: opts.max ?? 50 });
  return events;
}

function normalize(rawEvent) {
  const title = typeof rawEvent.title === "string" ? rawEvent.title : rawEvent.title?.en || rawEvent.title?.title || "Evento sem título";
  const eventTimeRaw = rawEvent.displayedDate || rawEvent.date_event || rawEvent.dateEvent;
  const eventTime = eventTimeRaw ? new Date(eventTimeRaw).getTime() : null;

  const coins = rawEvent.coins || [];
  const assets = coins.map((c) => (c.symbol || c.ticker || "").toUpperCase()).filter(Boolean);

  const categories = rawEvent.categories || [];
  const categoryText = categories.map((c) => c.name || c).join(",");
  const category = mapCategory(categoryText);

  const confidenceVote = rawEvent.percentage !== undefined ? Number(rawEvent.percentage) : null;

  return {
    sourceEventId: String(rawEvent.id ?? rawEvent.uuid ?? `${title}-${eventTimeRaw}`),
    title,
    description: rawEvent.description || null,
    category,
    assets,
    eventTime,
    confirmed: confidenceVote === null ? true : confidenceVote >= 50,
    sourceUrl: rawEvent.sourceUrl || null,
  };
}

module.exports = { name: "coinmarketcal", fetchRawEvents, normalize };

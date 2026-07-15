// Provider do CoinMarketCal -- eventos específicos de cripto (ETF, hard
// fork, listing, unlock, governança, parceria, etc). Precisa de
// COINMARKETCAL_API_KEY no .env (cadastro grátis em coinmarketcal.com/en/api).
//
// ATENÇÃO: o mapeamento de campos abaixo (title/displayedDate/coins/
// categories) é baseado na documentação pública da API v2, sem ter testado
// contra uma resposta real ainda (não temos chave em mãos nesta sessão) --
// validar contra uma resposta real assim que a chave existir e ajustar se
// os nomes de campo divergirem.
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
    sourceUrl: rawEvent.source || rawEvent.proof || null,
  };
}

module.exports = { name: "coinmarketcal", fetchRawEvents, normalize };

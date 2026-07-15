const axios = require("axios");
const { withRetry } = require("./httpRetry");
const config = require("../config");

// API v2 -- autenticação via header x-api-key (chave grátis, cadastro em coinmarketcal.com/en/api).
const BASE_URL = "https://api.coinmarketcal.com/v2/events";

async function getEvents({ page = 1, max = 50, dateRangeStart, dateRangeEnd } = {}) {
  const apiKey = config.knowledge.coinMarketCalApiKey;
  if (!apiKey) throw new Error("CoinMarketCal: COINMARKETCAL_API_KEY não configurada no .env");

  return withRetry(async () => {
    const params = { page, max };
    if (dateRangeStart) params.dateRangeStart = dateRangeStart;
    if (dateRangeEnd) params.dateRangeEnd = dateRangeEnd;
    const { data } = await axios.get(BASE_URL, { headers: { "x-api-key": apiKey }, params });
    const events = data && (data.body || data.data);
    if (!Array.isArray(events)) {
      throw new Error("CoinMarketCal: resposta inesperada da API");
    }
    return events;
  });
}

module.exports = { getEvents, BASE_URL };

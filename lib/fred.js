const axios = require("axios");
const { withRetry } = require("./httpRetry");
const config = require("../config");

// FRED (Federal Reserve Economic Data) -- API pública gratuita, chave instantânea
// em fredaccount.stlouisfed.org/apikeys. Dado oficial do Federal Reserve/BLS.
const BASE_URL = "https://api.stlouisfed.org/fred/releases/dates";

async function getReleaseDates(releaseId, { limit = 10 } = {}) {
  const apiKey = config.knowledge.fredApiKey;
  if (!apiKey) throw new Error("FRED: FRED_API_KEY não configurada no .env");

  return withRetry(async () => {
    const { data } = await axios.get(BASE_URL, {
      params: {
        release_id: releaseId,
        api_key: apiKey,
        file_type: "json",
        limit,
        sort_order: "desc",
      },
    });
    if (!data || !Array.isArray(data.release_dates)) {
      throw new Error("FRED: resposta inesperada da API");
    }
    return data.release_dates; // [{release_id, release_name, date}]
  });
}

module.exports = { getReleaseDates, BASE_URL };

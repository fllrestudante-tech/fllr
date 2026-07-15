const axios = require("axios");
const { withRetry } = require("./httpRetry");

// API pública da alternative.me -- sem chave, sem custo, atualiza ~1x/dia.
const BASE_URL = "https://api.alternative.me/fng/";

async function getFearGreedIndex(limit = 1) {
  return withRetry(async () => {
    const { data } = await axios.get(BASE_URL, { params: { limit, format: "json" } });
    if (!data || !Array.isArray(data.data)) {
      throw new Error("Fear&Greed: resposta inesperada da API");
    }
    return data.data; // [{value, value_classification, timestamp (segundos), time_until_update?}]
  });
}

module.exports = { getFearGreedIndex, BASE_URL };

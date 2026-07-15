const axios = require("axios");
const { withRetry } = require("./httpRetry");

// API pública da CoinGecko -- sem chave, sem custo. updated_at fica estável
// por alguns minutos (cache interno deles), não muda a cada chamada.
const BASE_URL = "https://api.coingecko.com/api/v3/global";

async function getGlobalMarketData() {
  return withRetry(async () => {
    const { data } = await axios.get(BASE_URL);
    if (!data || !data.data) {
      throw new Error("CoinGecko: resposta inesperada da API");
    }
    return data.data; // {market_cap_percentage: {btc, eth, ...}, total_market_cap: {usd}, total_volume: {usd}, updated_at (segundos), ...}
  });
}

module.exports = { getGlobalMarketData, BASE_URL };

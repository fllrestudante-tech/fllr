// Ponto único de acesso à lista de símbolos que o coletor multi-asset deve
// cobrir (o "Universe" da Fase A). Ninguém além deste módulo lê
// process.env.MARKET_SYMBOLS diretamente -- isso isola o resto do sistema
// do formato de configuração e dá ao futuro idea-dynamic-universe um único
// ponto de substituição (trocar "ler env" por "calcular por liquidez" sem
// tocar em nenhum consumidor).
//
// Sem MARKET_SYMBOLS configurado, cai pra [config.symbol] -- comportamento
// atual (1 símbolo só) preservado por padrão, zero risco pra quem não
// configurar nada de novo.
const config = require("../config");

function parseSymbolList(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function getUniverse({ env = process.env, fallbackSymbol = config.symbol } = {}) {
  const parsed = parseSymbolList(env.MARKET_SYMBOLS);
  const symbols = parsed.length > 0 ? [...new Set(parsed)] : [fallbackSymbol].filter(Boolean);
  return { symbols };
}

// Separa símbolo (ex: BTCUSDT) em base/quote (BTC/USDT) por sufixo conhecido
// -- só o suficiente pra registrar automaticamente a linha em `asset`
// (migração 0011) sem exigir `npm run knowledge-base -- set` manual pra
// cada símbolo novo do Universe. Enriquecimento (sector/narrative/tags)
// continua manual via CLI existente.
const KNOWN_QUOTE_ASSETS = ["USDT", "USDC", "USD"];

function parseBaseQuote(symbol) {
  for (const quote of KNOWN_QUOTE_ASSETS) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) {
      return { baseAsset: symbol.slice(0, -quote.length), quoteAsset: quote };
    }
  }
  return { baseAsset: symbol, quoteAsset: null };
}

module.exports = { getUniverse, parseSymbolList, parseBaseQuote };

// Lista curada de tickers conhecidos -- usada só pro caso de menção "nua"
// (ex: "LDO segue esticando", sem $/# e sem par USDT). Casar contra QUALQUER
// palavra maiúscula de 2-5 letras teria falso positivo alto demais (ex: "SV"
// em "ativar o 4H em SV" é jargão de setup, não ticker). Lista pequena e
// deliberada > regex genérico -- mesma disciplina de "não fabricar dado" já
// aplicada no resto do projeto. Expandir conforme канais/moedas reais
// aparecerem no histórico (ver lib/narrativeEngine/README.md).
const KNOWN_TICKERS = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "TRX", "TON", "LINK",
  "MATIC", "POL", "DOT", "AVAX", "SHIB", "LTC", "BCH", "UNI", "LDO", "ATOM",
  "ARB", "OP", "SUI", "APT", "NEAR", "INJ", "RENDER", "FET", "TIA", "SEI",
  "WIF", "PEPE", "FLOKI", "AAVE", "MKR", "CRV", "SNX", "GMX", "DYDX", "ENA",
  "ONDO", "JUP", "PYTH", "STX", "FIL", "ICP", "ETC", "XLM", "ALGO", "SAND",
  "MANA", "AXS", "GALA", "IMX", "RUNE", "KAS", "WLD", "ORDI", "1000PEPE",
  "1000SHIB", "1000FLOKI",
]);

module.exports = { KNOWN_TICKERS };

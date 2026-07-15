/**
 * Defaults por categoria de evento -- severidade (níveis definidos: 1 =
 * fomc/cpi/etf, 2 = unlock/hard_fork/listing, 3 = ama/partnership/
 * governance), volatilidade esperada e janela de impacto antes/depois.
 * São hipóteses iniciais, não valores travados -- ficam prontos pra serem
 * recalibrados quando o Event Impact Analyzer (futuro) tiver dado real de
 * quanto cada tipo de evento realmente move o mercado.
 */
const HOUR_MS = 60 * 60 * 1000;

const CATEGORY_DEFAULTS = {
  fomc: { severity: 1, expectedVolatility: "EXTREME", impactWindowBeforeMs: 24 * HOUR_MS, impactWindowAfterMs: 48 * HOUR_MS },
  cpi: { severity: 1, expectedVolatility: "HIGH", impactWindowBeforeMs: 12 * HOUR_MS, impactWindowAfterMs: 24 * HOUR_MS },
  payroll: { severity: 1, expectedVolatility: "MEDIUM", impactWindowBeforeMs: 6 * HOUR_MS, impactWindowAfterMs: 12 * HOUR_MS },
  gdp: { severity: 1, expectedVolatility: "MEDIUM", impactWindowBeforeMs: 6 * HOUR_MS, impactWindowAfterMs: 12 * HOUR_MS },
  etf: { severity: 1, expectedVolatility: "HIGH", impactWindowBeforeMs: 24 * HOUR_MS, impactWindowAfterMs: 24 * HOUR_MS },
  unlock: { severity: 2, expectedVolatility: "MEDIUM", impactWindowBeforeMs: 2 * HOUR_MS, impactWindowAfterMs: 24 * HOUR_MS },
  hard_fork: { severity: 2, expectedVolatility: "MEDIUM", impactWindowBeforeMs: 24 * HOUR_MS, impactWindowAfterMs: 24 * HOUR_MS },
  listing: { severity: 2, expectedVolatility: "HIGH", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 6 * HOUR_MS },
  delisting: { severity: 2, expectedVolatility: "HIGH", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 6 * HOUR_MS },
  burn: { severity: 2, expectedVolatility: "LOW", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 6 * HOUR_MS },
  airdrop: { severity: 2, expectedVolatility: "MEDIUM", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 12 * HOUR_MS },
  ama: { severity: 3, expectedVolatility: "LOW", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 2 * HOUR_MS },
  partnership: { severity: 3, expectedVolatility: "LOW", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 6 * HOUR_MS },
  governance: { severity: 3, expectedVolatility: "LOW", impactWindowBeforeMs: 6 * HOUR_MS, impactWindowAfterMs: 12 * HOUR_MS },
};

const DEFAULT_CATEGORY = { severity: 3, expectedVolatility: "LOW", impactWindowBeforeMs: 1 * HOUR_MS, impactWindowAfterMs: 6 * HOUR_MS };

function getCategoryDefaults(category) {
  return CATEGORY_DEFAULTS[category] || DEFAULT_CATEGORY;
}

// Setores conhecidos -- heurística inicial simples pra inferir market_scope
// quando o evento é sobre um ativo específico. Refinável depois.
const SECTOR_TICKERS = {
  MEME: ["DOGE", "SHIB", "PEPE", "FLOKI", "WIF", "BONK"],
  DEFI: ["UNI", "AAVE", "MKR", "CRV", "COMP", "SNX"],
  RWA: ["ONDO", "POLYX", "CFG"],
  AI: ["FET", "AGIX", "RNDR", "TAO"],
};

/**
 * GLOBAL se o evento não menciona ativo específico (ex: CPI) ou menciona
 * vários sem setor comum. Ticker principal (BTC/ETH/SOL) ou nome do setor
 * se for um único ativo reconhecido; senão o próprio ticker.
 */
function inferMarketScope(assets) {
  if (!assets || assets.length === 0) return "GLOBAL";
  if (assets.length > 1) return "GLOBAL";

  const ticker = assets[0].toUpperCase();
  if (["BTC", "ETH", "SOL"].includes(ticker)) return ticker;
  for (const [sector, tickers] of Object.entries(SECTOR_TICKERS)) {
    if (tickers.includes(ticker)) return sector;
  }
  return ticker;
}

module.exports = { CATEGORY_DEFAULTS, getCategoryDefaults, inferMarketScope };

// Menções a indicadores/contexto macro -- domínio separado de extractStructure
// (padrão gráfico) porque alimenta dimensões diferentes do Source
// Reliability/Validation Engine (ex: "mentionsFunding" pesa diferente de
// "hasResistance" no score final).
const PATTERNS = {
  rsi: /\bRSI\b/i,
  macd: /\bMACD\b/i,
  ema: /\bEMAs?\d*\b/i,
  fibonacci: /fibonacci|\bfibo\b/i,
  bollinger: /bollinger/i,
  funding: /\bfunding\b/i,
  openInterest: /open interest|\bOI\b/i,
  etf: /\bETFs?\b/i,
  fomc: /\bFOMC\b|federal reserve|\bfed\b/i,
  cpi: /\bCPI\b/i,
  dominance: /domin[âa]ncia|dominance/i,
  whale: /\bwhale\b|\bbaleia\b/i,
  liquidity: /liquidez|liquidity/i,
};

function extractIndicators(text) {
  const features = {};
  const lower = text || "";
  for (const [name, regex] of Object.entries(PATTERNS)) {
    features[name] = regex.test(lower);
  }
  return features;
}

module.exports = { extractIndicators, INDICATOR_KEYS: Object.keys(PATTERNS) };

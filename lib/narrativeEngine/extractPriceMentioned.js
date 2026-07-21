// Preço mencionado explicitamente (ex: "US$ 45.230", "$0,85") -- v0 é
// deliberadamente conservador aqui (só casa números com prefixo de moeda
// explícito, não qualquer número solto -- um "4H" ou "2026" não deve virar
// "preço"). Por isso confidenceBreakdown.js dá peso 0 a este campo por
// enquanto: existe pra registrar o dado quando aparece, não pra ser
// confiável ainda.
const PRICE_REGEX = /(?:US\$|R\$|\$)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)/;

function extractPriceMentioned(text) {
  if (!text) return null;
  const match = text.match(PRICE_REGEX);
  return match ? match[0].trim() : null;
}

module.exports = { extractPriceMentioned };

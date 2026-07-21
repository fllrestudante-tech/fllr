// Achata o resultado de todos os extractores num único "feature vector" de
// booleanos -- é o formato que o Learning Engine (futuro) vai consumir pra
// treinar sobre histórico completo, mesmo antes de qualquer modelo de IA
// existir (ver README.md deste diretório).
function buildFeatureVector({ ticker, pair, direction, timeframe, structure, indicators, hasLink, priceMentioned }) {
  const vector = {
    hasTicker: Boolean(ticker),
    hasPair: Boolean(pair),
    hasDirection: Boolean(direction),
    hasTimeframe: Boolean(timeframe),
    hasPriceMentioned: Boolean(priceMentioned),
    hasLink: Boolean(hasLink),
  };
  for (const [name, value] of Object.entries(structure || {})) {
    vector[`has${capitalize(name)}`] = value;
  }
  for (const [name, value] of Object.entries(indicators || {})) {
    vector[`mentions${capitalize(name)}`] = value;
  }
  return vector;
}

function capitalize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

module.exports = { buildFeatureVector };

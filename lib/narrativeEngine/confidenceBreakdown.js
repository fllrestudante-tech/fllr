// Confidence explicável -- em vez de só "confidence: 0.82", guarda o motivo
// por trás de cada ponto. Pesos definidos pelo usuário; "price" pesa 0 de
// propósito (extractPriceMentioned.js ainda não é confiável o bastante pra
// contar pontos -- ver comentário lá). O Source Reliability Engine (futuro)
// consome esse breakdown pra explicar por que confiou (ou não) num sinal.
const WEIGHTS = {
  ticker: 20,
  direction: 15,
  timeframe: 15,
  price: 0,
  technicalTerms: 20,
  signalPattern: 15,
};
const MAX_TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 85

function hasAnyTrue(obj) {
  return Boolean(obj) && Object.values(obj).some(Boolean);
}

function computeConfidenceBreakdown({ ticker, direction, timeframe, priceMentioned, structure, indicators, signalType }) {
  const hasTechnicalTerms = hasAnyTrue(structure) || hasAnyTrue(indicators);
  const breakdown = {
    ticker: ticker ? WEIGHTS.ticker : 0,
    direction: direction ? WEIGHTS.direction : 0,
    timeframe: timeframe ? WEIGHTS.timeframe : 0,
    price: priceMentioned ? WEIGHTS.price : 0,
    technicalTerms: hasTechnicalTerms ? WEIGHTS.technicalTerms : 0,
    signalPattern: signalType ? WEIGHTS.signalPattern : 0,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { breakdown, total, maxTotal: MAX_TOTAL, confidence: total / MAX_TOTAL };
}

module.exports = { computeConfidenceBreakdown, WEIGHTS, MAX_TOTAL };

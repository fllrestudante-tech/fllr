// Tom geral da mensagem (bullish/bearish/neutral) -- distinto de
// extractDirection.js (que é sobre "que lado operar"). Uma mensagem pode ser
// bearish em tom ("mercado fraco") sem necessariamente ser uma call de
// SHORT. Calibrado contra o histórico real do Velatrader Squad Oficial
// auditado nesta sessão (ex: "esticando", "força compradora", "abriu espaço
// de valorização", "devolveu a alta", "tendência baixista").
const BULLISH_TERMS = [
  "breakout", "buy zone", "pump", "moon", "compra", "compre", "\\balta\\b",
  "rompimento", "acumulaç[ãa]o", "gem", "listing", "esticando", "for[çc]a compradora",
  "valorizaç[ãa]o", "sinais de for[çc]a",
];
const BEARISH_TERMS = [
  "dump", "\\bqueda\\b", "venda a descoberto", "\\bbaixa\\b", "distribuiç[ãa]o",
  "despejo", "tend[êe]ncia baixista", "devolveu.{0,25}alta", "abalar o mercado",
  "fraqueza",
];

function countHits(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => new RegExp(term, "i").test(lower));
}

function extractSentiment(text) {
  if (!text) return { sentiment: "neutral", confidence: 0, matchedTerms: [] };
  const bullishHits = countHits(text, BULLISH_TERMS);
  const bearishHits = countHits(text, BEARISH_TERMS);
  const total = bullishHits.length + bearishHits.length;

  let sentiment = "neutral";
  if (bullishHits.length > bearishHits.length) sentiment = "bullish";
  else if (bearishHits.length > bullishHits.length) sentiment = "bearish";

  const confidence = total === 0 ? 0 : Math.min(1, total / 3);
  return { sentiment, confidence, matchedTerms: [...bullishHits, ...bearishHits] };
}

module.exports = { extractSentiment };

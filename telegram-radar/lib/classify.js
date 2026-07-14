// Classificação por palavra-chave — sem LLM, determinística e testável.
const BULLISH_KEYWORDS = [
  "breakout",
  "buy zone",
  "pump",
  "moon",
  "long",
  "compra",
  "compre",
  "alta",
  "rompimento",
  "acumulacao",
  "gem",
  "listing",
];
const BEARISH_KEYWORDS = ["dump", "short", "queda", "venda", "venda a descoberto", "baixa", "distribuicao", "despejo"];

function classify(text) {
  const lower = (text || "").toLowerCase();
  const bullishHits = BULLISH_KEYWORDS.filter((k) => lower.includes(k));
  const bearishHits = BEARISH_KEYWORDS.filter((k) => lower.includes(k));
  const totalHits = bullishHits.length + bearishHits.length;

  let sentiment = "neutral";
  if (bullishHits.length > bearishHits.length) sentiment = "bullish";
  else if (bearishHits.length > bullishHits.length) sentiment = "bearish";

  // confiança cresce com o número de termos batidos, capada em 1 (3+ termos = confiança máxima)
  const confidence = totalHits === 0 ? 0 : Math.min(1, totalHits / 3);

  return { sentiment, confidence, matchedKeywords: [...bullishHits, ...bearishHits] };
}

module.exports = { classify, BULLISH_KEYWORDS, BEARISH_KEYWORDS };

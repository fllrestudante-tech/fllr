// Direção de trade (LONG/SHORT) -- conceito distinto de sentimento geral
// (ver extractSentiment.js): aqui é especificamente "que lado a mensagem
// sugere operar", não "o tom é otimista/pessimista". Score por contagem de
// termos, igual à lógica já validada em classify.js -- maior contagem vence,
// empate (incluindo 0x0) é null (direção não fica clara, não "neutro").
const LONG_TERMS = [
  "long", "compra", "compre", "comprando", "compr[aá]vel", "força compradora",
  "zona de compra", "buy zone", "romper a resist", "rompimento da resist",
  "aposta na revers", "reversão de alta",
];
const SHORT_TERMS = [
  "short", "venda", "vender", "vendendo", "venda a descoberto",
  "zona de venda", "romper o suporte", "rompimento do suporte",
  "tend[êe]ncia baixista", "revers[ãa]o de baixa",
];

function countHits(text, terms) {
  const lower = text.toLowerCase();
  return terms.filter((term) => new RegExp(term, "i").test(lower)).length;
}

function extractDirection(text) {
  if (!text) return null;
  const longHits = countHits(text, LONG_TERMS);
  const shortHits = countHits(text, SHORT_TERMS);
  if (longHits === 0 && shortHits === 0) return null;
  if (longHits > shortHits) return "LONG";
  if (shortHits > longHits) return "SHORT";
  return null; // empate -- não fica claro, não fabricar direção
}

module.exports = { extractDirection };

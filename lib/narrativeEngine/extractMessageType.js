// Classifica o TIPO da mensagem (não o conteúdo do sinal) -- permite medir
// depois "esse canal posta 200 mensagens/dia, mas só 18 são calls reais".
// Calibrado contra o histórico real do Velatrader Squad Oficial auditado
// nesta sessão. Regras em cascata, ordem importa (primeira que bater
// decide) -- depende de extractTicker/extractStructure/extractIndicators/
// extractDirection já terem rodado (ver classify.js, o orquestrador).
const TYPES = ["ADVERTISEMENT", "WARNING", "EXIT", "ENTRY", "UPDATE", "ANALYSIS", "MACRO", "NEWS", "CHAT"];

const ADVERTISEMENT_REGEX = /assine|clique aqui|link na bio|promo[çc][ãa]o exclusiva|desconto exclusivo|cupom/i;
const WARNING_REGEX = /⚠️|aten[çc][ãa]o|cuidado|fiquem preparados|\balerta\b|vai abalar/i;
const EXIT_REGEX = /\b(sa[íi] da posi[çc][ãa]o|fechei a posi[çc][ãa]o|encerrei|stop batido|stopado|take profit batido|tp batido)\b/i;
const ENTRY_REGEX = /\b(entrada|entrei|zona de (compra|venda))\b/i;
const UPDATE_REGEX = /atualiz|\bupdate\b/i;
const MACRO_REGEX = /nasdaq|federal reserve|\bfed\b|\bfomc\b|\bcpi\b|mercado global|s&p ?500/i;
const LINK_REGEX = /https?:\/\//i;

function extractMessageType(text, { ticker } = {}) {
  const t = (text || "").trim();
  if (!t) return "CHAT";

  if (ADVERTISEMENT_REGEX.test(t)) return "ADVERTISEMENT";
  if (WARNING_REGEX.test(t)) return "WARNING";
  if (EXIT_REGEX.test(t)) return "EXIT";
  if (ticker && ENTRY_REGEX.test(t)) return "ENTRY";
  if (UPDATE_REGEX.test(t)) return "UPDATE";
  if (ticker) return "ANALYSIS";
  if (MACRO_REGEX.test(t)) return "MACRO";
  if (LINK_REGEX.test(t)) return "NEWS";
  return "CHAT";
}

module.exports = { extractMessageType, MESSAGE_TYPES: TYPES };

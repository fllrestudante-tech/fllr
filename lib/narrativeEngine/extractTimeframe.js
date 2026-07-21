// Timeframe mencionado -- normaliza pra uma forma canônica curta (4H, 1D,
// 1W, 1M). Formato explícito (ex: "4H") tem prioridade sobre palavra por
// extenso (ex: "mensal"), por ser inequívoco; primeiro match encontrado
// vence -- v0 retorna 1 timeframe só (o "principal" da mensagem), não uma
// lista (mensagens raramente comparam 2 timeframes ao mesmo tempo nos
// exemplos reais auditados).
const EXPLICIT_RULES = [
  { regex: /\b(1|3|5|15|30)\s?m(in)?\b/i, normalize: (m) => `${m[1]}m` },
  { regex: /\b(1|2|4|6|8|12)\s?h\b/i, normalize: (m) => `${m[1]}H` },
  { regex: /\b(1|3)\s?d\b/i, normalize: (m) => `${m[1]}D` },
  { regex: /\b(1|2)\s?w\b/i, normalize: (m) => `${m[1]}W` },
];
const WORD_RULES = [
  { regex: /di[áa]rio/i, value: "1D" },
  { regex: /semanal/i, value: "1W" },
  { regex: /mensal/i, value: "1M" },
];

function extractTimeframe(text) {
  if (!text) return null;
  for (const rule of EXPLICIT_RULES) {
    const match = text.match(rule.regex);
    if (match) return rule.normalize(match);
  }
  for (const rule of WORD_RULES) {
    if (rule.regex.test(text)) return rule.value;
  }
  return null;
}

module.exports = { extractTimeframe };

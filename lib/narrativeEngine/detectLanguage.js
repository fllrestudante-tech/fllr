// Heurística leve pt-BR vs en -- os canais monitorados hoje são todos em
// português, então isso é mais um "selo honesto" do que detecção robusta:
// se o texto não tiver sinal nenhum (ex: mensagem só com ticker/emoji),
// retorna "unknown" em vez de forçar "pt-BR" sem base.
const PT_HINTS = /[ãõçáéíóúâêô]|\b(que|não|para|com|está|são|foi|mais|como|também)\b/i;
const EN_HINTS = /\b(the|and|is|are|with|for|this|that|will|would)\b/i;

function detectLanguage(text) {
  if (!text || text.trim().length === 0) return "unknown";
  const hasPt = PT_HINTS.test(text);
  const hasEn = EN_HINTS.test(text);
  if (hasPt && !hasEn) return "pt-BR";
  if (hasEn && !hasPt) return "en";
  if (hasPt && hasEn) return "pt-BR"; // acentos/palavras PT são um sinal mais forte que stopwords EN curtas
  return "unknown";
}

module.exports = { detectLanguage };

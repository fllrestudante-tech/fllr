// Interface comum a todo Brain da plataforma (Market, Structure, e os
// futuros) -- sem isso, um Brain Orchestrator/Decision Engine futuro teria
// que conhecer a forma específica de cada Brain em vez de tratá-los de
// forma uniforme. `state`/`confidence`/`score`/`reasons`/`evidence`/
// `missingEvidence`/`metadata` são o núcleo comum; cada Brain acrescenta
// seus próprios campos de detalhe via `extra` (ex: trend/sentiment/risk no
// Market Brain, swings/trend/liquidity no Structure Brain).
//
// `confidence` e `score` são propositalmente números com significados
// diferentes (pedido explícito, não um erro de nomenclatura): `confidence`
// mede o quanto o cálculo confia no próprio dado (completude/qualidade da
// evidência observada); `score` mede a força intrínseca do que foi
// encontrado (ex: um "bull" pode ter confiança alta com força fraca, ou
// vice-versa). Cada Brain decide sua própria fórmula pros dois; este
// módulo só embrulha o resultado final, não calcula nada.
function createBrainResult({
  state,
  confidence,
  score,
  reasons = [],
  evidence = [],
  missingEvidence = [],
  sourceDataTime = null,
  startedAt,
  dependsOn = [],
  extra = {},
}) {
  return {
    state,
    confidence,
    score,
    reasons,
    evidence,
    missingEvidence,
    metadata: {
      generatedAt: new Date().toISOString(),
      sourceDataTime,
      processingMs: startedAt != null ? Date.now() - startedAt : null,
      dependsOn,
    },
    ...extra,
  };
}

module.exports = { createBrainResult };

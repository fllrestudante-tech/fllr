// Knowledge Resolver -- interpreta conhecimento (hoje: nenhum ainda, só
// config global) e devolve objetos de contexto nomeados por Brain, nunca
// parâmetros soltos. Fase 1 (agora): pass-through de `config.structure.*`
// -- `db`/`symbol` já são recebidos mas ainda não usados pra decidir nada,
// só estabelecem o desacoplamento antes de existir dado real (Asset
// Statistics) pra alimentar a decisão. Fase 2 (quando Asset Statistics
// existir): passa a variar por volatilidade/regime real do símbolo, sem
// exigir mudança nenhuma em quem já chama isso (lib/knowledgeBase/contextBuilder.js
// e, através dela, os *BrainData.js).
//
// Nota de design (evitar God Object): este e lib/knowledgeBase/statisticalResolver.js
// são conceitualmente 2 membros de uma FAMÍLIA de Resolvers especializados
// (Knowledge Resolver aqui, Statistics Resolver lá -- Context/Market/
// Portfolio Resolver ainda não existem, ver idea-knowledge-ecosystem).
// Cada Resolver novo que a Knowledge Base ganhar deve nascer como módulo
// próprio, nunca como mais um método dentro de um Resolver genérico
// gigante -- mesmo que hoje só 2 arquivos existam, a divisão já é por
// responsabilidade, não por conveniência de arquivo único.
const config = require("../../config");

function envelope(context, source = "config-default") {
  return { context, knowledgeVersion: 1, confidence: 100, generatedAt: new Date().toISOString(), source };
}

/** @returns {{context: {lookback:number}, knowledgeVersion:number, confidence:number, generatedAt:string, source:string}} StructureContext */
function resolveStructureContext(db, symbol) {
  return envelope({ lookback: config.structure.lookback });
}

/** @returns StructureContext-compatível + equalTolerancePct/sweepReversalLookahead (LiquidityContext) */
function resolveLiquidityContext(db, symbol) {
  return envelope({
    lookback: config.structure.lookback,
    equalTolerancePct: config.structure.equalTolerancePct,
    sweepReversalLookahead: config.structure.sweepReversalLookahead,
  });
}

/** @returns FvgContext: exhaustionLookback */
function resolveFvgContext(db, symbol) {
  return envelope({ exhaustionLookback: config.structure.exhaustionLookback });
}

/** @returns OrderBlockContext: confirmAge/mitigationThreshold/exhaustionLookback */
function resolveOrderBlockContext(db, symbol) {
  return envelope({
    confirmAge: config.structure.confirmAge,
    mitigationThreshold: config.structure.mitigationThreshold,
    exhaustionLookback: config.structure.exhaustionLookback,
  });
}

module.exports = { resolveStructureContext, resolveLiquidityContext, resolveFvgContext, resolveOrderBlockContext };

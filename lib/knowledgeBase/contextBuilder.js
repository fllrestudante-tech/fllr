// Context Builder -- única API que os *BrainData.js chamam pra obter
// parâmetro de execução; nunca a tabela `asset`, nunca o Resolver, nunca
// Signals diretamente. Monta o contexto final combinando o que o
// Resolver interpretou com qualquer Knowledge Signal cadastrado (nenhum
// ainda -- lib/knowledgeBase/signals.js nasce vazio nesta rodada, então o
// merge abaixo é um no-op hoje, mas já é o encaixe certo pra quando
// Capital Flow Engine/Regime Engine registrarem sinais reais).
const resolver = require("./resolver");
const { listSignals, getSignal } = require("./signals");

function applySignals(envelope, db, symbol) {
  let context = envelope.context;
  for (const name of listSignals()) {
    const patch = getSignal(name, db, symbol);
    if (patch) context = { ...context, ...patch };
  }
  return { ...envelope, context };
}

function buildStructureContext(db, symbol) {
  return applySignals(resolver.resolveStructureContext(db, symbol), db, symbol);
}

function buildLiquidityContext(db, symbol) {
  return applySignals(resolver.resolveLiquidityContext(db, symbol), db, symbol);
}

function buildFvgContext(db, symbol) {
  return applySignals(resolver.resolveFvgContext(db, symbol), db, symbol);
}

function buildOrderBlockContext(db, symbol) {
  return applySignals(resolver.resolveOrderBlockContext(db, symbol), db, symbol);
}

module.exports = { buildStructureContext, buildLiquidityContext, buildFvgContext, buildOrderBlockContext };

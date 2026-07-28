// Knowledge Signals -- encaixe pra sinais reutilizáveis derivados de
// conhecimento (mudança de narrativa, rotação de capital, regime de
// funding, atividade de baleias...), mantendo os Brains desacoplados do
// dado bruto. Nasce deliberadamente VAZIO nesta rodada -- nenhum sinal
// real existe ainda porque Capital Flow Engine/Regime Engine/Correlation
// Brain (que produziriam esses sinais) continuam `idea`, não
// implementados. Registrar um sinal aqui no futuro não exige mudar
// lib/knowledgeBase/contextBuilder.js nem nenhum *BrainData.js -- eles já
// aplicam qualquer sinal cadastrado via getSignal.
const registry = new Map();

function registerSignal(name, computeFn) {
  registry.set(name, computeFn);
}

function getSignal(name, db, symbol) {
  const computeFn = registry.get(name);
  return computeFn ? computeFn(db, symbol) : null;
}

function listSignals() {
  return [...registry.keys()];
}

module.exports = { registerSignal, getSignal, listSignals };

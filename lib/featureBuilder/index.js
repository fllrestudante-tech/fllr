// Feature Builder -- índice "burro" por design (mesmo princípio de
// lib/knowledgeBase/contextBuilder.js): só concatena os builders por
// domínio, nenhuma lógica própria. Não conhece Brain, não conhece
// decisão -- só transforma conhecimento (via Statistical Resolver) em
// Features atômicas reutilizáveis e testáveis.
const { buildFundingFeatures } = require("./funding");
const { buildVolatilityFeatures } = require("./volatility");
const { buildLiquidityFeatures } = require("./liquidity");
const { buildOpenInterestFeatures } = require("./openInterest");
const { buildVolumeFeatures } = require("./volume");

function buildAllFeatures(db, symbol) {
  return {
    funding: buildFundingFeatures(db, symbol),
    volatility: buildVolatilityFeatures(db, symbol),
    liquidity: buildLiquidityFeatures(db, symbol),
    openInterest: buildOpenInterestFeatures(db, symbol),
    volume: buildVolumeFeatures(db, symbol),
  };
}

function flattenFeatures(featuresByDomain) {
  return Object.values(featuresByDomain).flat();
}

// Forma compacta pra persistência de histórico (runtime/metrics) -- só os 3
// campos que importam pra acompanhar tendência (state/strength/confidence),
// nunca o `observation`/`metadata` inteiro.
function summarizeFeatures(featuresByDomain) {
  const summary = {};
  for (const feature of flattenFeatures(featuresByDomain)) {
    summary[feature.id] = {
      state: feature.interpretation.state,
      strength: feature.strength,
      confidence: feature.confidence,
    };
  }
  return summary;
}

module.exports = { buildAllFeatures, flattenFeatures, summarizeFeatures };

// Página Features -- grade símbolo × feature, via buildAllFeatures já
// existente (lib/featureBuilder). Nenhum cálculo novo -- só itera o
// Universe e devolve o objeto Feature completo (state/strength/confidence/
// metadata) por símbolo, sem resumir pra ON/OFF.
const { DEFAULT_DB_PATH } = require("../infra/db");
const { withReadonlyDb } = require("../infra/withReadonlyDb");
const { getUniverse } = require("../universe");
const { buildAllFeatures, flattenFeatures } = require("../featureBuilder");
const { isFeatureActive } = require("../featureBuilder/featureShape");

function readFeaturesForSymbol(db, symbol) {
  return flattenFeatures(buildAllFeatures(db, symbol)).map((f) => ({ ...f, active: isFeatureActive(f) }));
}

function readFeatures({ dbPath = DEFAULT_DB_PATH, symbols } = {}) {
  const symbolsList = symbols ?? getUniverse().symbols;
  return withReadonlyDb(
    dbPath,
    (db) => symbolsList.map((symbol) => ({ symbol, features: readFeaturesForSymbol(db, symbol) })),
    symbolsList.map((symbol) => ({ symbol, features: [] }))
  );
}

module.exports = { readFeatures, readFeaturesForSymbol };

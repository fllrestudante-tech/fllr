// Mapa estático de "quem consome o quê" na Knowledge Base -- curado à mão
// (mesmo espírito de experiments/definitions.json), não derivado de
// runtime. `real` é verificável hoje lendo o código citado; `future` é
// intenção documentada (ideias já registradas no Feature Registry), nunca
// uma relação fabricada -- ver lib/knowledgeBase/contextBuilder.js pro
// porquê disso existir (evitar conhecimento órfão).
const REAL = [
  { field: "StructureContext", consumer: "lib/brains/structureBrainData.js", via: "contextBuilder.buildStructureContext" },
  { field: "LiquidityContext", consumer: "lib/brains/liquidityBrainData.js", via: "contextBuilder.buildLiquidityContext" },
  { field: "FvgContext", consumer: "lib/brains/fvgBrainData.js", via: "contextBuilder.buildFvgContext" },
  { field: "OrderBlockContext", consumer: "lib/brains/orderBlockBrainData.js", via: "contextBuilder.buildOrderBlockContext" },
];

const FUTURE = [
  { field: "sector / narrative / category / subCategory / tags", consumer: "idea-dynamic-universe, idea-opportunity-alice", status: "não conectado ainda" },
  { field: "relations", consumer: "idea-knowledge-graph, idea-correlation-brain", status: "não conectado ainda" },
];

module.exports = { REAL, FUTURE };

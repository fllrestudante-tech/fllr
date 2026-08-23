// Página Research/Evolution -- mesma base do Capability Map/DNA Matrix
// (npm run capability-map/dna-matrix), lida direto do Feature Registry.
// Nenhuma camada nova de cálculo -- só contagens sobre o que já existe.
const { loadRegistry, listByType, listByStatus } = require("../registry/registryStore");
const featureIds = require("../featureBuilder/featureIds");

function tagValue(obj, prefix) {
  const tag = (obj.tags || []).find((t) => t.startsWith(`${prefix}:`));
  return tag ? tag.slice(prefix.length + 1) : null;
}

function countByTagPrefix(objects, prefix) {
  const counts = {};
  for (const obj of objects) {
    const value = tagValue(obj, prefix);
    if (!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function readEvolution() {
  const objects = loadRegistry();

  const byStatus = {
    production: listByStatus(objects, "production").length,
    replay: listByStatus(objects, "replay").length,
    research: listByStatus(objects, "research").length,
    idea: listByStatus(objects, "idea").length,
    deprecated: listByStatus(objects, "deprecated").length,
  };

  return {
    totalResearchObjects: objects.length,
    byStatus,
    byCriticality: countByTagPrefix(objects, "criticality"), // criticality:core/mission-critical/supporting/experimental/optional
    byProof: countByTagPrefix(objects, "proof"), // proof:reasoning/benchmark/replay/production
    byNature: countByTagPrefix(objects, "nature"), // nature:cognitive/knowledge/operational
    brainsCount: listByType(objects, "brain").length,
    experimentsCount: listByType(objects, "experiment").length,
    featuresCount: Object.keys(featureIds).length, // Features do Feature Builder ainda não são Research Objects registrados
  };
}

module.exports = { readEvolution, tagValue, countByTagPrefix };

const test = require("node:test");
const assert = require("node:assert/strict");
const { tagValue, countByTagPrefix, readEvolution } = require("../../lib/webDashboard/researchReader");

test("tagValue: extrai o valor de uma tag prefixo:valor", () => {
  assert.equal(tagValue({ tags: ["brain", "criticality:core"] }, "criticality"), "core");
});

test("tagValue: sem tag com esse prefixo devolve null", () => {
  assert.equal(tagValue({ tags: ["brain"] }, "criticality"), null);
});

test("countByTagPrefix: conta ocorrências por valor de tag", () => {
  const objects = [{ tags: ["proof:replay"] }, { tags: ["proof:replay"] }, { tags: ["proof:production"] }, { tags: [] }];
  assert.deepEqual(countByTagPrefix(objects, "proof"), { replay: 2, production: 1 });
});

test("readEvolution: contra o registry real, devolve contagens coerentes (smoke test)", () => {
  const result = readEvolution();
  assert.ok(result.totalResearchObjects > 0);
  assert.ok(result.byStatus.production >= 0);
  assert.ok(result.brainsCount >= 5); // os 5+ Brains já entregues
  assert.equal(result.featuresCount, 8); // 8 Features atômicas do Feature Builder v1
});

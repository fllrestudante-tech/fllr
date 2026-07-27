const test = require("node:test");
const assert = require("node:assert/strict");
const { createResearchObject, validateResearchObject } = require("../../lib/registry/researchObject");

function validMinimal(overrides = {}) {
  return {
    id: "feature-bos",
    type: "feature",
    name: "Break of Structure",
    status: "production",
    maturity: 2,
    owner: { type: "internal", name: "internal" },
    references: [],
    tags: [],
    dependsOn: [],
    metrics: {},
    history: [{ date: "2026-01-01T00:00:00.000Z", action: "created" }],
    ...overrides,
  };
}

test("createResearchObject: preenche defaults quando campos não são passados", () => {
  const obj = createResearchObject(
    { id: "feature-x", type: "feature", name: "X", status: "idea" },
    { now: () => "2026-07-27T00:00:00.000Z" }
  );
  assert.equal(obj.description, "");
  assert.deepEqual(obj.owner, { type: "internal", name: "internal" });
  assert.deepEqual(obj.references, []);
  assert.equal(obj.maturity, 0);
  assert.deepEqual(obj.tags, []);
  assert.deepEqual(obj.dependsOn, []);
  assert.deepEqual(obj.metrics, {});
  assert.deepEqual(obj.history, []);
  assert.equal(obj.createdAt, "2026-07-27T00:00:00.000Z");
  assert.equal(obj.updatedAt, "2026-07-27T00:00:00.000Z");
});

test("createResearchObject: preserva campos explicitamente passados", () => {
  const obj = createResearchObject({
    id: "feature-x",
    type: "feature",
    name: "X",
    status: "research",
    maturity: 3,
    owner: { type: "community", name: "OpenAlice" },
    references: [{ type: "github", url: "https://github.com/x" }],
    tags: ["smc"],
    dependsOn: ["brain-structure"],
    metrics: { replay: { accuracy: 0.7 } },
  });
  assert.equal(obj.maturity, 3);
  assert.deepEqual(obj.owner, { type: "community", name: "OpenAlice" });
  assert.deepEqual(obj.tags, ["smc"]);
  assert.deepEqual(obj.dependsOn, ["brain-structure"]);
  assert.deepEqual(obj.metrics, { replay: { accuracy: 0.7 } });
});

test("validateResearchObject: objeto mínimo válido passa", () => {
  const { valid, errors } = validateResearchObject(validMinimal());
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
});

test("validateResearchObject: rejeita objeto não-objeto", () => {
  assert.equal(validateResearchObject(null).valid, false);
  assert.equal(validateResearchObject("x").valid, false);
});

for (const field of ["id", "type", "name", "status"]) {
  test(`validateResearchObject: exige ${field} não vazio`, () => {
    const { valid, errors } = validateResearchObject(validMinimal({ [field]: "" }));
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes(field)));
  });
}

test("validateResearchObject: rejeita id fora de kebab-case", () => {
  const { valid, errors } = validateResearchObject(validMinimal({ id: "Feature_BOS" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("kebab-case")));
});

test("validateResearchObject: rejeita maturity fora de 0-5 ou não-inteiro", () => {
  assert.equal(validateResearchObject(validMinimal({ maturity: 6 })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ maturity: -1 })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ maturity: 2.5 })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ maturity: 0 })).valid, true);
  assert.equal(validateResearchObject(validMinimal({ maturity: 5 })).valid, true);
});

test("validateResearchObject: owner precisa ser objeto com type e name", () => {
  assert.equal(validateResearchObject(validMinimal({ owner: "internal" })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ owner: { type: "internal" } })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ owner: { name: "internal" } })).valid, false);
});

test("validateResearchObject: references precisa ser array de objetos com type", () => {
  assert.equal(validateResearchObject(validMinimal({ references: "não é array" })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ references: [{ url: "https://x" }] })).valid, false);
  assert.equal(
    validateResearchObject(validMinimal({ references: [{ type: "github", url: "https://x" }] })).valid,
    true
  );
});

test("validateResearchObject: tags e dependsOn precisam ser array de strings", () => {
  assert.equal(validateResearchObject(validMinimal({ tags: "smc" })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ tags: [1, 2] })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ dependsOn: [1] })).valid, false);
});

test("validateResearchObject: metrics precisa ter fases como objeto e campos nomeados numéricos", () => {
  assert.equal(validateResearchObject(validMinimal({ metrics: { replay: "não é objeto" } })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ metrics: { replay: { accuracy: "70%" } } })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ metrics: { replay: { accuracy: 0.7 } } })).valid, true);
  assert.equal(
    validateResearchObject(validMinimal({ metrics: { replay: { accuracy: 0.7, campoNaoNomeado: "ok" } } })).valid,
    true,
    "chaves extras não nomeadas continuam permitidas"
  );
});

test("validateResearchObject: history precisa ser array de {date, action}", () => {
  assert.equal(validateResearchObject(validMinimal({ history: "não é array" })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ history: [{ action: "created" }] })).valid, false);
  assert.equal(validateResearchObject(validMinimal({ history: [{ date: "2026-01-01" }] })).valid, false);
});

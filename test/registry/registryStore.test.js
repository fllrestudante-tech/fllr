const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadRegistry,
  saveRegistry,
  findById,
  listByType,
  listByStatus,
  listConsumers,
  groupConsumersByStatus,
  validateRegistryIntegrity,
  upsertResearchObject,
} = require("../../lib/registry/registryStore");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function obj(overrides = {}) {
  return {
    id: "feature-bos",
    type: "feature",
    name: "Break of Structure",
    description: "",
    owner: { type: "internal", name: "internal" },
    references: [],
    status: "production",
    maturity: 2,
    tags: [],
    dependsOn: [],
    metrics: {},
    history: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("loadRegistry: arquivo ausente devolve array vazio", () => {
  const result = loadRegistry({ filePath: tmpFile("nao-existe.json") });
  assert.deepEqual(result, []);
});

test("loadRegistry: JSON inválido lança erro claro", () => {
  const file = tmpFile("invalido.json");
  fs.writeFileSync(file, "{ isso não é json válido");
  assert.throws(() => loadRegistry({ filePath: file }), /Registry JSON inválido/);
  fs.unlinkSync(file);
});

test("loadRegistry: exige que o conteúdo seja um array", () => {
  const file = tmpFile("nao-array.json");
  fs.writeFileSync(file, JSON.stringify({ nao: "array" }));
  assert.throws(() => loadRegistry({ filePath: file }), /deve conter um array/);
  fs.unlinkSync(file);
});

test("loadRegistry: arquivo válido devolve o array parseado", () => {
  const file = tmpFile("valido.json");
  fs.writeFileSync(file, JSON.stringify([obj()]));
  const result = loadRegistry({ filePath: file });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "feature-bos");
  fs.unlinkSync(file);
});

test("saveRegistry: grava ordenado por id, legível de volta", () => {
  const file = tmpFile("save.json");
  saveRegistry([obj({ id: "feature-z" }), obj({ id: "feature-a" })], { filePath: file });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(raw.map((o) => o.id), ["feature-a", "feature-z"]);
  fs.unlinkSync(file);
});

test("findById/listByType/listByStatus filtram corretamente", () => {
  const objects = [
    obj({ id: "brain-market", type: "brain", status: "production" }),
    obj({ id: "feature-bos", type: "feature", status: "research" }),
  ];
  assert.equal(findById(objects, "brain-market").id, "brain-market");
  assert.equal(findById(objects, "não-existe"), null);
  assert.deepEqual(
    listByType(objects, "feature").map((o) => o.id),
    ["feature-bos"]
  );
  assert.deepEqual(
    listByStatus(objects, "production").map((o) => o.id),
    ["brain-market"]
  );
});

test("upsertResearchObject: insere novo objeto com history inicial 'created'", () => {
  const next = upsertResearchObject([], { id: "feature-x", type: "feature", name: "X", status: "idea" }, {
    now: () => "2026-07-27T00:00:00.000Z",
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].createdAt, "2026-07-27T00:00:00.000Z");
  assert.deepEqual(next[0].history, [{ date: "2026-07-27T00:00:00.000Z", action: "created" }]);
});

test("upsertResearchObject: atualiza preservando createdAt e history antigo", () => {
  const created = upsertResearchObject([], { id: "feature-x", type: "feature", name: "X", status: "idea" }, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const updated = upsertResearchObject(created, { id: "feature-x", type: "feature", name: "X", status: "idea", description: "atualizado" }, {
    now: () => "2026-02-01T00:00:00.000Z",
  });
  assert.equal(updated[0].createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(updated[0].updatedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(updated[0].description, "atualizado");
  assert.equal(updated[0].history.length, 1, "nada mudou em status/maturity, nenhuma entrada nova");
});

test("upsertResearchObject: gera entrada de history quando status muda", () => {
  const created = upsertResearchObject([], { id: "feature-x", type: "feature", name: "X", status: "idea" }, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const updated = upsertResearchObject(created, { id: "feature-x", type: "feature", name: "X", status: "research" }, {
    now: () => "2026-02-01T00:00:00.000Z",
    note: "primeiro replay",
  });
  const lastEntry = updated[0].history[updated[0].history.length - 1];
  assert.equal(lastEntry.action, "status: idea → research");
  assert.equal(lastEntry.note, "primeiro replay");
});

test("upsertResearchObject: gera entrada de history quando maturity muda", () => {
  const created = upsertResearchObject([], { id: "feature-x", type: "feature", name: "X", status: "idea", maturity: 1 }, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const updated = upsertResearchObject(created, { id: "feature-x", type: "feature", name: "X", status: "idea", maturity: 2 }, {
    now: () => "2026-02-01T00:00:00.000Z",
  });
  const lastEntry = updated[0].history[updated[0].history.length - 1];
  assert.equal(lastEntry.action, "maturity: 1 → 2");
});

test("upsertResearchObject: rejeita objeto inválido", () => {
  assert.throws(() => upsertResearchObject([], { id: "ID_INVALIDO", type: "feature", name: "X", status: "idea" }));
});

test("listConsumers: direto e transitivo, vazio quando ninguém depende", () => {
  const objects = [
    obj({ id: "feature-bos", dependsOn: [] }),
    obj({ id: "brain-structure", dependsOn: ["feature-bos"] }),
    obj({ id: "engine-replay", dependsOn: ["brain-structure"] }),
    obj({ id: "engine-isolado", dependsOn: [] }),
  ];
  const direct = listConsumers(objects, "feature-bos", { transitive: false });
  assert.deepEqual(direct.map((o) => o.id), ["brain-structure"]);

  const transitive = listConsumers(objects, "feature-bos");
  assert.deepEqual(
    transitive.map((o) => o.id).sort(),
    ["brain-structure", "engine-replay"]
  );

  assert.deepEqual(listConsumers(objects, "engine-isolado"), []);
});

test("groupConsumersByStatus: agrupa por status, filtra por type, vazio quando não há consumidores desse tipo", () => {
  const objects = [
    obj({ id: "brain-fvg" }),
    obj({ id: "experiment-a", type: "experiment", status: "research", dependsOn: ["brain-fvg"] }),
    obj({ id: "experiment-b", type: "experiment", status: "validated", dependsOn: ["brain-fvg"] }),
    obj({ id: "experiment-c", type: "experiment", status: "validated", dependsOn: ["brain-fvg"] }),
    obj({ id: "brain-outro", type: "brain", status: "production", dependsOn: ["brain-fvg"] }),
  ];

  const result = groupConsumersByStatus(objects, "brain-fvg", { type: "experiment" });
  assert.equal(result.total, 3);
  assert.deepEqual(result.byStatus, { research: 1, validated: 2 });

  const empty = groupConsumersByStatus(objects, "brain-fvg", { type: "paper" });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.byStatus, {});
});

test("validateRegistryIntegrity: detecta id duplicado e dependsOn quebrado, aceita registro limpo", () => {
  const duplicated = [obj({ id: "feature-x" }), obj({ id: "feature-x" })];
  assert.equal(validateRegistryIntegrity(duplicated).valid, false);

  const broken = [obj({ id: "feature-x", dependsOn: ["não-existe"] })];
  assert.equal(validateRegistryIntegrity(broken).valid, false);

  const clean = [obj({ id: "feature-x" }), obj({ id: "brain-structure", dependsOn: ["feature-x"] })];
  const result = validateRegistryIntegrity(clean);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { demoRuntimeDir, DemoRuntimeDirRejectedError, TEST_WORKER_ENV, OPERATIONAL_DIR } = require("../lib/demoRuntimePaths");

// =====================================================================
// Item 4 da Rodada 4 -- CRYPTO10_DEMO_RUNTIME_DIR NUNCA pode redirecionar
// estado financeiro fora de um worker de teste explicitamente
// identificado. Fail-closed: qualquer condição fora das 3 exigidas
// (marker exclusivo + dentro de os.tmpdir() + nunca o operacional real)
// LANÇA, nunca ignora silenciosamente e cai pro default.
// =====================================================================

test("demoRuntimeDir: sem override -> caminho operacional real do projeto", () => {
  assert.equal(demoRuntimeDir({}), OPERATIONAL_DIR);
});

test("demoRuntimeDir: override presente mas SEM a variável de teste exclusiva -> lança (simula .env de produção malconfigurado)", () => {
  assert.throws(() => demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: "C:\\qualquer\\coisa" }), DemoRuntimeDirRejectedError);
});

test("demoRuntimeDir: override + variável de teste, mas fora de os.tmpdir() -> lança", () => {
  assert.throws(
    () => demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: path.join(__dirname, "..", "runtime", "outra-coisa"), [TEST_WORKER_ENV]: "1" }),
    DemoRuntimeDirRejectedError
  );
});

test("demoRuntimeDir: override + variável de teste + dentro de os.tmpdir() -> aceito", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demoruntimepaths-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.equal(demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: tmp, [TEST_WORKER_ENV]: "1" }), path.resolve(tmp));
});

test("demoRuntimeDir: variável de teste presente mas com valor diferente de '1' -> lança (nunca aceita truthy genérico)", () => {
  for (const value of ["true", "yes", "TRUE", "", "0"]) {
    assert.throws(() => demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: os.tmpdir(), [TEST_WORKER_ENV]: value }), DemoRuntimeDirRejectedError, `valor "${value}" nunca deveria ser aceito`);
  }
});

test("demoRuntimeDir: override aponta exatamente pro runtime/demo operacional real, mesmo com marker+tmpdir -- lança (nunca deixa um teste sobrescrever o real por coincidência de caminho)", () => {
  assert.throws(() => demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: OPERATIONAL_DIR, [TEST_WORKER_ENV]: "1" }), DemoRuntimeDirRejectedError);
});

test("demoRuntimeDir: override ausente/vazio -> operacional, independente da variável de teste", () => {
  assert.equal(demoRuntimeDir({ CRYPTO10_DEMO_RUNTIME_DIR: "", [TEST_WORKER_ENV]: "1" }), OPERATIONAL_DIR);
});

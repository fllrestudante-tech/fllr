const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { atomicWriteFileSync, atomicWriteJsonSync } = require("../lib/atomicWrite");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("atomicWriteFileSync: grava o conteúdo, arquivo legível de volta", () => {
  const file = tmpFile("roundtrip.txt");
  atomicWriteFileSync(file, "conteudo-de-teste");
  assert.equal(fs.readFileSync(file, "utf8"), "conteudo-de-teste");
  fs.unlinkSync(file);
});

test("atomicWriteFileSync: cria o diretório se não existir", () => {
  const dir = tmpFile("dir");
  const file = path.join(dir, "arquivo.txt");
  atomicWriteFileSync(file, "x");
  assert.equal(fs.readFileSync(file, "utf8"), "x");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync: sobrescreve e não deixa nenhum .tmp para trás", () => {
  const file = tmpFile("overwrite.txt");
  atomicWriteFileSync(file, "primeira");
  atomicWriteFileSync(file, "segunda");
  assert.equal(fs.readFileSync(file, "utf8"), "segunda");
  const dir = path.dirname(file);
  const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes(path.basename(file)) && f.endsWith(".tmp"));
  assert.deepEqual(leftoverTmp, []);
  fs.unlinkSync(file);
});

test("atomicWriteFileSync: se a escrita do .tmp falhar, o destino existente fica intacto", () => {
  const file = tmpFile("crash.txt");
  atomicWriteFileSync(file, "conteudo-original");

  const fakeFs = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: () => {
      throw new Error("falha simulada no meio da escrita");
    },
    renameSync: fs.renameSync,
  };

  assert.throws(() => atomicWriteFileSync(file, "conteudo-novo-que-nao-deveria-aparecer", { fsImpl: fakeFs }));
  assert.equal(fs.readFileSync(file, "utf8"), "conteudo-original");
  fs.unlinkSync(file);
});

test("atomicWriteFileSync: se o rename falhar, o destino existente fica intacto (nenhum truncamento parcial)", () => {
  const file = tmpFile("crash-rename.txt");
  atomicWriteFileSync(file, "conteudo-original");

  const fakeFs = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
    renameSync: () => {
      throw new Error("falha simulada no rename");
    },
  };

  assert.throws(() => atomicWriteFileSync(file, "conteudo-novo", { fsImpl: fakeFs }));
  assert.equal(fs.readFileSync(file, "utf8"), "conteudo-original");
  const dir = path.dirname(file);
  for (const f of fs.readdirSync(dir)) {
    if (f.includes(path.basename(file)) && f.endsWith(".tmp")) fs.unlinkSync(path.join(dir, f));
  }
  fs.unlinkSync(file);
});

test("atomicWriteJsonSync: serializa objeto como JSON legível", () => {
  const file = tmpFile("snapshot.json");
  atomicWriteJsonSync(file, { foo: "bar", n: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { foo: "bar", n: 2 });
  fs.unlinkSync(file);
});

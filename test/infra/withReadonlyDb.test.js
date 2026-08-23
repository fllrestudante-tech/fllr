const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { withReadonlyDb } = require("../../lib/infra/withReadonlyDb");
const { openDb } = require("../../lib/infra/db");

function tmpDbPath(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

test("withReadonlyDb: arquivo inexistente devolve fallback sem lançar", () => {
  const result = withReadonlyDb("/caminho/que/nao/existe.db", () => "nunca chamado", "fallback");
  assert.equal(result, "fallback");
});

test("withReadonlyDb: abre readonly, roda fn, fecha depois", () => {
  const dbPath = tmpDbPath("readonly.db");
  openDb(dbPath).close(); // garante que o arquivo existe com o schema aplicado

  const result = withReadonlyDb(dbPath, (db) => db.prepare("SELECT 1 as one").get().one);
  cleanup(dbPath);

  assert.equal(result, 1);
});

test("withReadonlyDb: erro dentro de fn devolve fallback, não propaga", () => {
  const dbPath = tmpDbPath("readonly-error.db");
  openDb(dbPath).close();

  const result = withReadonlyDb(
    dbPath,
    () => {
      throw new Error("boom");
    },
    "fallback"
  );
  cleanup(dbPath);

  assert.equal(result, "fallback");
});

test("withReadonlyDb: conexão é readonly de verdade -- tentar escrever falha", () => {
  const dbPath = tmpDbPath("readonly-write.db");
  openDb(dbPath).close();

  const result = withReadonlyDb(
    dbPath,
    (db) => {
      try {
        db.prepare("INSERT INTO events_log (uuid, event_name, payload, occurred_at) VALUES ('x','x','{}','x')").run();
        return "escreveu (bug)";
      } catch {
        return "bloqueado";
      }
    },
    "fallback"
  );
  cleanup(dbPath);

  assert.equal(result, "bloqueado");
});

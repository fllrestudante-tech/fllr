const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LockBusyError, acquireReservationLock, withReservationLock } = require("../lib/demoReservationLock");

function tempLockPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-resvlock-${label}-`));
  return { dir, lockPath: path.join(dir, "reservation.lock") };
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("acquireReservationLock: adquire e libera -- arquivo de lock some após release()", (t) => {
  const { dir, lockPath } = tempLockPath("basic");
  t.after(() => cleanup(dir));
  const lock = acquireReservationLock(lockPath);
  assert.ok(fs.existsSync(lockPath));
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("acquireReservationLock: segunda tentativa enquanto o lock está preso -> LockBusyError (maxAttempts baixo, nunca trava o processo)", (t) => {
  const { dir, lockPath } = tempLockPath("busy");
  t.after(() => cleanup(dir));
  const lock = acquireReservationLock(lockPath);
  assert.throws(() => acquireReservationLock(lockPath, { maxAttempts: 1, retryDelayMs: 1 }), LockBusyError);
  lock.release();
});

test("acquireReservationLock: lock obsoleto (PID dono já morto) é reclamado automaticamente", (t) => {
  const { dir, lockPath } = tempLockPath("stale-pid");
  t.after(() => cleanup(dir));
  // Um PID que quase certamente não existe mais no sistema -- simula um
  // processo que travou o lock e morreu sem liberar.
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: "fake", acquiredAtMs: Date.now() }));
  const lock = acquireReservationLock(lockPath, { maxAttempts: 3, retryDelayMs: 5 });
  assert.ok(fs.existsSync(lockPath));
  lock.release();
});

test("acquireReservationLock: lock mais velho que staleAfterMs é reclamado mesmo com PID vivo (o próprio processo de teste)", (t) => {
  const { dir, lockPath } = tempLockPath("stale-age");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: "fake", acquiredAtMs: Date.now() - 100000 }));
  const lock = acquireReservationLock(lockPath, { staleAfterMs: 1000, maxAttempts: 3, retryDelayMs: 5 });
  assert.ok(fs.existsSync(lockPath));
  lock.release();
});

test("acquireReservationLock: lock ilegível (JSON corrompido) é tratado como obsoleto e reclamado", (t) => {
  const { dir, lockPath } = tempLockPath("corrupt");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "não é json");
  const lock = acquireReservationLock(lockPath, { maxAttempts: 3, retryDelayMs: 5 });
  assert.ok(fs.existsSync(lockPath));
  lock.release();
});

test("withReservationLock: libera o lock mesmo quando fn lança", (t) => {
  const { dir, lockPath } = tempLockPath("throws");
  t.after(() => cleanup(dir));
  assert.throws(() =>
    withReservationLock(lockPath, () => {
      throw new Error("erro proposital dentro do lock");
    })
  );
  assert.equal(fs.existsSync(lockPath), false, "o lock nunca deveria sobreviver a uma exceção dentro de fn");
});

test("withReservationLock: devolve o valor de retorno de fn", (t) => {
  const { dir, lockPath } = tempLockPath("return-value");
  t.after(() => cleanup(dir));
  const result = withReservationLock(lockPath, () => 42);
  assert.equal(result, 42);
});

test("nenhum teste deste arquivo importa axios/net/http/better-sqlite3", () => {
  const firstTestLine = fs
    .readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((line) => line.startsWith("test("));
  const importsOnly = fs.readFileSync(__filename, "utf8").split("\n").slice(0, firstTestLine).join("\n");
  for (const token of ["axios", "node:http", '"http"', "better-sqlite3", "node:net", '"net"']) {
    assert.ok(!importsOnly.includes(token), `imports deste arquivo não deveriam mencionar "${token}"`);
  }
});

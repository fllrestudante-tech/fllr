const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonSnapshot, startHeartbeat } = require("../lib/heartbeatWriter");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("writeJsonSnapshot: grava o payload como JSON, criando o diretório se preciso", () => {
  const dir = tmpFile("dir");
  const file = path.join(dir, "snapshot.json");
  writeJsonSnapshot(file, { foo: "bar" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(raw, { foo: "bar" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeJsonSnapshot: sobrescreve o arquivo em escritas subsequentes", () => {
  const file = tmpFile("overwrite.json");
  writeJsonSnapshot(file, { n: 1 });
  writeJsonSnapshot(file, { n: 2 });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.n, 2);
  fs.unlinkSync(file);
});

test("startHeartbeat: primeiro write acontece após initialDelayMs, inclui lastHeartbeatAt + payload", (t, done) => {
  const file = tmpFile("heartbeat.json");
  const heartbeat = startHeartbeat(file, () => ({ metrics: { runs: 1 } }), { initialDelayMs: 10, intervalMs: 100000 });

  setTimeout(() => {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(typeof raw.lastHeartbeatAt, "string");
    assert.deepEqual(raw.metrics, { runs: 1 });
    heartbeat.stop();
    fs.unlinkSync(file);
    done();
  }, 40);
});

test("startHeartbeat: stop() cancela os timers -- nenhum write depois disso", (t, done) => {
  const file = tmpFile("stopped.json");
  const heartbeat = startHeartbeat(file, () => ({ metrics: { runs: 1 } }), { initialDelayMs: 10, intervalMs: 20 });

  setTimeout(() => {
    heartbeat.stop();
    const contentAfterStop = fs.readFileSync(file, "utf8");
    setTimeout(() => {
      const contentLater = fs.readFileSync(file, "utf8");
      assert.equal(contentAfterStop, contentLater, "arquivo não deveria mudar depois do stop()");
      fs.unlinkSync(file);
      done();
    }, 60);
  }, 30);
});

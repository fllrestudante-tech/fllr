const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readLifecycle, writeRunning, writeHeartbeat, writeCleanShutdown, detectBootIncident } = require("../lib/lifecycle");

function tmpFilePath() {
  return path.join(os.tmpdir(), `bot-cripto10-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanup(filePath) {
  fs.rmSync(filePath, { force: true });
}

test("readLifecycle: null quando o arquivo não existe", () => {
  const filePath = tmpFilePath();
  assert.equal(readLifecycle(filePath), null);
});

test("readLifecycle: null (não derruba) quando o arquivo está corrompido", () => {
  const filePath = tmpFilePath();
  fs.writeFileSync(filePath, "{ isso não é json válido");
  assert.equal(readLifecycle(filePath), null);
  cleanup(filePath);
});

test("writeRunning + readLifecycle: round-trip", () => {
  const filePath = tmpFilePath();
  const record = writeRunning(filePath, { pid: 123, startedAt: "2026-07-23T10:00:00.000Z" });
  assert.equal(record.status, "running");
  assert.equal(record.pid, 123);
  assert.ok(record.bootId);

  const read = readLifecycle(filePath);
  assert.equal(read.status, "running");
  assert.equal(read.pid, 123);
  cleanup(filePath);
});

test("writeHeartbeat: atualiza só lastHeartbeatAt, mantém o resto", () => {
  const filePath = tmpFilePath();
  const running = writeRunning(filePath, { pid: 1, startedAt: "2026-07-23T10:00:00.000Z" });
  const afterHeartbeat = writeHeartbeat(filePath, running, Date.parse("2026-07-23T10:05:00.000Z"));

  assert.equal(afterHeartbeat.status, "running");
  assert.equal(afterHeartbeat.pid, 1);
  assert.equal(afterHeartbeat.lastHeartbeatAt, "2026-07-23T10:05:00.000Z");
  cleanup(filePath);
});

test("writeCleanShutdown: marca status clean_shutdown", () => {
  const filePath = tmpFilePath();
  const running = writeRunning(filePath, { pid: 1, startedAt: "2026-07-23T10:00:00.000Z" });
  const afterShutdown = writeCleanShutdown(filePath, running, Date.parse("2026-07-23T10:10:00.000Z"));

  assert.equal(afterShutdown.status, "clean_shutdown");
  const read = readLifecycle(filePath);
  assert.equal(read.status, "clean_shutdown");
  cleanup(filePath);
});

test("detectBootIncident: primeira vez (previous null) -- sem incidente", () => {
  const result = detectBootIncident({ previous: null, osUptimeSec: 100, now: Date.now() });
  assert.equal(result.isIncident, false);
});

test("detectBootIncident: shutdown limpo anterior -- sem incidente", () => {
  const result = detectBootIncident({
    previous: { status: "clean_shutdown", lastHeartbeatAt: "2026-07-23T10:00:00.000Z" },
    osUptimeSec: 5000,
    now: Date.parse("2026-07-23T10:05:00.000Z"),
  });
  assert.equal(result.isIncident, false);
});

test("detectBootIncident: os_reboot -- SO ligou depois do último heartbeat conhecido", () => {
  const lastHeartbeat = Date.parse("2026-07-23T08:27:00.000Z");
  const now = Date.parse("2026-07-23T11:49:00.000Z");
  const osUptimeSec = (now - Date.parse("2026-07-23T08:35:00.000Z")) / 1000; // SO ligou 08:35, depois do heartbeat (08:27)

  const result = detectBootIncident({ previous: { status: "running", lastHeartbeatAt: new Date(lastHeartbeat).toISOString() }, osUptimeSec, now });

  assert.equal(result.isIncident, true);
  assert.equal(result.rootCause, "os_reboot");
  assert.equal(result.startedAt, lastHeartbeat);
  assert.equal(result.endedAt, now);
});

test("detectBootIncident: process_crash -- SO seguiu ligado, só o supervisor morreu", () => {
  const lastHeartbeat = Date.parse("2026-07-23T08:27:00.000Z");
  const now = Date.parse("2026-07-23T08:30:00.000Z");
  const osUptimeSec = (now - Date.parse("2026-07-20T00:00:00.000Z")) / 1000; // SO ligado há dias, bem antes do heartbeat

  const result = detectBootIncident({ previous: { status: "running", lastHeartbeatAt: new Date(lastHeartbeat).toISOString() }, osUptimeSec, now });

  assert.equal(result.isIncident, true);
  assert.equal(result.rootCause, "process_crash");
});

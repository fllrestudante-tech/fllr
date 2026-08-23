const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readReplay, readReplaySummary } = require("../../lib/webDashboard/replayReader");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("readReplay: stats.json inexistente reporta available:false honestamente", () => {
  const result = readReplay({ statsPath: tmpFile("nao-existe.json") });
  assert.equal(result.available, false);
  assert.ok(result.reason.includes("npm run replay"));
});

test("readReplay: repassa decisionBrainReadiness/brainAccuracy do stats.json sem recalcular", () => {
  const file = tmpFile("stats.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      generatedAt: "2026-07-30T00:00:00.000Z",
      snapshotCount: 77,
      brainAccuracy: { market: { accuracy: 11 } },
      decisionBrainReadiness: { ready: false, checks: { sampleSize: { pass: false } } },
    })
  );

  const result = readReplay({ statsPath: file });
  fs.unlinkSync(file);

  assert.equal(result.available, true);
  assert.equal(result.snapshotCount, 77);
  assert.deepEqual(result.decisionBrainReadiness, { ready: false, checks: { sampleSize: { pass: false } } });
  assert.deepEqual(result.brainAccuracy, { market: { accuracy: 11 } });
  assert.equal(result.snapshotProgressPct, Math.round((77 / result.snapshotTarget) * 1000) / 10);
});

test("readReplaySummary: versão condensada expõe só o essencial pra Overview", () => {
  const file = tmpFile("stats-summary.json");
  fs.writeFileSync(file, JSON.stringify({ snapshotCount: 100, decisionBrainReadiness: { ready: true } }));

  const result = readReplaySummary({ statsPath: file });
  fs.unlinkSync(file);

  assert.equal(result.available, true);
  assert.equal(result.snapshotCount, 100);
  assert.equal(result.decisionBrainReady, true);
});

test("readReplaySummary: sem stats.json, available:false", () => {
  const result = readReplaySummary({ statsPath: tmpFile("nao-existe-2.json") });
  assert.equal(result.available, false);
});

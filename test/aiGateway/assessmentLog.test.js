const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { logAssessment, SCHEMA_VERSION } = require("../../lib/aiGateway/assessmentLog");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("logAssessment: cria arquivo (e diretório, se preciso) e grava schemaVersion + time", () => {
  const dir = tmpFile("ai-gateway-log-dir");
  const file = path.join(dir, "ai-assessments.jsonl");
  logAssessment({ status: "success", provider: "openai" }, file);

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const record = JSON.parse(lines[0]);
  assert.equal(lines.length, 1);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.ok(record.time);
  assert.equal(record.status, "success");
  assert.equal(record.provider, "openai");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("logAssessment: segunda chamada faz append, não sobrescreve a primeira", () => {
  const file = tmpFile("ai-assessments-append.jsonl");
  logAssessment({ requestId: "a" }, file);
  logAssessment({ requestId: "b" }, file);

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).requestId, "a");
  assert.equal(JSON.parse(lines[1]).requestId, "b");

  fs.unlinkSync(file);
});

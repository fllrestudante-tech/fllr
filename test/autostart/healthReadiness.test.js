const test = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_SHAPE, isHealthResponseReady } = require("../../lib/autostart/healthReadiness");

const READY_BODY = { status: "ok", service: "crypto10-dashboard", mode: "safe", tradingExecutionEnabled: false, database: "ok" };

test("REQUIRED_SHAPE: contrato estável esperado", () => {
  assert.deepEqual(REQUIRED_SHAPE, { status: "ok", mode: "safe", tradingExecutionEnabled: false, database: "ok" });
});

test("isHealthResponseReady: 200 + corpo perfeito -> true", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: READY_BODY }), true);
});

test("isHealthResponseReady: 503 (degraded) mesmo com corpo 'perfeito' -> false (statusCode manda)", () => {
  assert.equal(isHealthResponseReady({ statusCode: 503, body: READY_BODY }), false);
});

test("isHealthResponseReady: status diferente de 'ok' -> false", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, status: "degraded" } }), false);
});

test("isHealthResponseReady: mode diferente de 'safe' -> false", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, mode: "invalid" } }), false);
});

test("isHealthResponseReady: tradingExecutionEnabled=true -> false", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, tradingExecutionEnabled: true } }), false);
});

test("isHealthResponseReady: tradingExecutionEnabled como string 'false' (não booleano) -> false -- comparação estrita", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, tradingExecutionEnabled: "false" } }), false);
});

test("isHealthResponseReady: database diferente de 'ok' -> false", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, database: "unavailable" } }), false);
});

test("isHealthResponseReady: corpo ausente/null/undefined -> false, nunca lança", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: null }), false);
  assert.equal(isHealthResponseReady({ statusCode: 200, body: undefined }), false);
  assert.equal(isHealthResponseReady({ statusCode: 200 }), false);
});

test("isHealthResponseReady: corpo não é objeto (string/array/número) -> false, nunca lança", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: "ok" }), false);
  assert.equal(isHealthResponseReady({ statusCode: 200, body: 200 }), false);
  assert.equal(isHealthResponseReady({ statusCode: 200, body: [] }), false);
});

test("isHealthResponseReady: chamada sem nenhum argumento -> false, nunca lança", () => {
  assert.doesNotThrow(() => isHealthResponseReady());
  assert.equal(isHealthResponseReady(), false);
});

test("isHealthResponseReady: campos extras no corpo não derrubam a aprovação (só os 4 campos que importam são checados)", () => {
  assert.equal(isHealthResponseReady({ statusCode: 200, body: { ...READY_BODY, extra: "qualquer coisa" } }), true);
});

test("isHealthResponseReady: determinístico", () => {
  const input = { statusCode: 200, body: READY_BODY };
  assert.equal(isHealthResponseReady(input), isHealthResponseReady(input));
});

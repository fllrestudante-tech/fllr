const test = require("node:test");
const assert = require("node:assert/strict");
const { processStatus, circuitBreakerStatus } = require("../../lib/webDashboard/headerReader");

test("processStatus: processo ausente do snapshot é 'unknown'", () => {
  assert.equal(processStatus({ processes: {} }, "bot"), "unknown");
  assert.equal(processStatus(null, "bot"), "unknown");
});

test("processStatus: RUNNING sem degraded é 'ok'", () => {
  assert.equal(processStatus({ processes: { bot: { operationalState: "RUNNING", degraded: false } } }, "bot"), "ok");
});

test("processStatus: RUNNING com degraded=true é 'degraded'", () => {
  assert.equal(processStatus({ processes: { bot: { operationalState: "RUNNING", degraded: true } } }, "bot"), "degraded");
});

test("processStatus: estado diferente de RUNNING é 'down'", () => {
  assert.equal(processStatus({ processes: { bot: { operationalState: "STOPPED" } } }, "bot"), "down");
});

test("circuitBreakerStatus: sem circuitBreakerUntil é 'off'", () => {
  assert.equal(circuitBreakerStatus({ circuitBreakerUntil: null }, Date.now()), "off");
});

test("circuitBreakerStatus: now antes de circuitBreakerUntil é 'on'", () => {
  const now = 1000;
  assert.equal(circuitBreakerStatus({ circuitBreakerUntil: 2000 }, now), "on");
});

test("circuitBreakerStatus: now depois de circuitBreakerUntil é 'off' (já expirou)", () => {
  const now = 3000;
  assert.equal(circuitBreakerStatus({ circuitBreakerUntil: 2000 }, now), "off");
});

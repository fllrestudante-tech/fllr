const test = require("node:test");
const assert = require("node:assert/strict");
const { nextLoopDelay } = require("../lib/backoff");

test("nextLoopDelay: sem falhas, mantém o delay base", () => {
  assert.equal(nextLoopDelay(0, 10000, 120000), 10000);
});

test("nextLoopDelay: cresce exponencialmente a cada falha consecutiva", () => {
  assert.equal(nextLoopDelay(1, 10000, 120000), 20000);
  assert.equal(nextLoopDelay(2, 10000, 120000), 40000);
  assert.equal(nextLoopDelay(3, 10000, 120000), 80000);
});

test("nextLoopDelay: não ultrapassa o teto maxMs", () => {
  assert.equal(nextLoopDelay(10, 10000, 120000), 120000);
});

test("nextLoopDelay: valores negativos tratados como sem falha (delay base)", () => {
  assert.equal(nextLoopDelay(-1, 10000, 120000), 10000);
});

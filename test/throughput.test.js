const test = require("node:test");
const assert = require("node:assert/strict");
const { ratePerMinute, computeThroughput } = require("../lib/throughput");

test("ratePerMinute: converte contagem/duração pra taxa por minuto", () => {
  assert.equal(ratePerMinute(30, 60000), 30); // 30 em 1min = 30/min
  assert.equal(ratePerMinute(1, 60000 * 60), 1 / 60); // 1 em 1h = 1/60 por min
});

test("ratePerMinute: durationMs zero ou ausente retorna null (evita divisão por zero)", () => {
  assert.equal(ratePerMinute(10, 0), null);
  assert.equal(ratePerMinute(10, null), null);
  assert.equal(ratePerMinute(10, undefined), null);
});

test("computeThroughput: sem janela fechada ainda (lastWindow null), tudo null -- não forja taxa", () => {
  const result = computeThroughput(null);
  assert.deepEqual(result, { insertedPerMin: null, errorsPerMin: null, runsPerMin: null });
});

test("computeThroughput: com janela fechada, calcula as 3 taxas", () => {
  const lastWindow = { runs: 10, inserted: 8, errors: 2, closedAt: "2026-01-01T00:00:00.000Z", durationMs: 60000 };
  const result = computeThroughput(lastWindow);
  assert.equal(result.insertedPerMin, 8);
  assert.equal(result.errorsPerMin, 2);
  assert.equal(result.runsPerMin, 10);
});

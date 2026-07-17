const test = require("node:test");
const assert = require("node:assert/strict");
const { getSla, computeExpectedNextAt, computeLag } = require("../lib/slaRegistry");

test("getSla: domínio listado retorna o SLA configurado", () => {
  const sla = getSla("funding");
  assert.equal(sla.expectedIntervalMs, 5 * 60 * 1000);
  assert.equal(sla.provider, "bybit");
});

test("getSla: domínio não listado cai no default (cobre providers novos do Knowledge Collector)", () => {
  const sla = getSla("um_provider_que_nao_existe_ainda");
  assert.equal(sla.expectedIntervalMs, 60 * 60 * 1000);
  assert.equal(sla.provider, null);
});

test("computeExpectedNextAt: null quando nunca houve sucesso", () => {
  assert.equal(computeExpectedNextAt(null, "funding"), null);
});

test("computeExpectedNextAt: soma o intervalo esperado ao último sucesso", () => {
  const lastSuccessAt = "2026-07-16T08:00:00.000Z";
  const result = computeExpectedNextAt(lastSuccessAt, "funding");
  assert.equal(result, "2026-07-16T08:05:00.000Z");
});

test("computeLag: nunca teve sucesso -- tudo null, não dá pra calcular lag", () => {
  const result = computeLag("funding", null);
  assert.deepEqual(result, { domain: "funding", expectedNextAt: null, lagMs: null, isLate: null });
});

test("computeLag: dentro do prazo -- lagMs negativo, isLate false", () => {
  const now = new Date("2026-07-16T08:01:00.000Z").getTime(); // esperado 08:05, ainda não chegou lá
  const result = computeLag("funding", "2026-07-16T08:00:00.000Z", now);
  assert.equal(result.expectedNextAt, "2026-07-16T08:05:00.000Z");
  assert.equal(result.isLate, false);
  assert.ok(result.lagMs < 0);
});

test("computeLag: atrasado -- lagMs positivo (ex. do spec: esperado 08:00, recebido 08:01 -> 1min de lag)", () => {
  // funding esperado a cada 5min; última coleta 07:55 -> esperado 08:00; agora é 08:01 -> 1min atrasado
  const now = new Date("2026-07-16T08:01:00.000Z").getTime();
  const result = computeLag("funding", "2026-07-16T07:55:00.000Z", now);
  assert.equal(result.expectedNextAt, "2026-07-16T08:00:00.000Z");
  assert.equal(result.isLate, true);
  assert.equal(result.lagMs, 60 * 1000);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAlertAggregator } = require("../lib/alertAggregator");

test("record: primeira ocorrência de uma chave manda na hora (action=send)", () => {
  const agg = createAlertAggregator({ windowMs: 1000, now: () => 0 });
  const result = agg.record("bybit_collector", "caiu", "ERROR");
  assert.equal(result.action, "send");
  assert.equal(result.count, 1);
});

test("record: repetições da mesma chave dentro da janela são suprimidas, contador cresce", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 100;
  const r2 = agg.record("bybit_collector", "caiu", "ERROR");
  t = 500;
  const r3 = agg.record("bybit_collector", "caiu", "ERROR");
  assert.equal(r2.action, "suppress");
  assert.equal(r2.count, 2);
  assert.equal(r3.action, "suppress");
  assert.equal(r3.count, 3);
});

test("record: depois que a janela expira, a próxima ocorrência manda de novo (nova janela)", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 2000; // passou da janela de 1000ms
  const result = agg.record("bybit_collector", "caiu", "ERROR");
  assert.equal(result.action, "send");
  assert.equal(result.count, 1);
});

test("record: chaves diferentes têm janelas independentes", () => {
  const agg = createAlertAggregator({ windowMs: 1000, now: () => 0 });
  const r1 = agg.record("bybit_collector", "caiu", "ERROR");
  const r2 = agg.record("fear_greed_collector", "caiu", "ERROR");
  assert.equal(r1.action, "send");
  assert.equal(r2.action, "send");
});

test("flushExpired: bucket com count=1 (nunca suprimiu nada) não gera resumo -- some silenciosamente", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 2000;
  const expired = agg.flushExpired();
  assert.equal(expired.length, 0);
});

test("flushExpired: bucket com repetições vira um resumo com contador ao expirar", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 100;
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 200;
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 2000; // janela expirou
  const expired = agg.flushExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].key, "bybit_collector");
  assert.equal(expired[0].count, 3);
  assert.equal(expired[0].message, "caiu");
});

test("flushExpired: bucket ainda dentro da janela não é retornado (só quando expira de verdade)", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 500;
  agg.record("bybit_collector", "caiu", "ERROR");
  const expired = agg.flushExpired(); // ainda em t=500, janela de 1000ms não fechou
  assert.equal(expired.length, 0);
});

test("flushExpired: remove os buckets expirados do mapa interno (não repete o resumo numa segunda chamada)", () => {
  let t = 0;
  const agg = createAlertAggregator({ windowMs: 1000, now: () => t });
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 100;
  agg.record("bybit_collector", "caiu", "ERROR");
  t = 2000;
  const first = agg.flushExpired();
  const second = agg.flushExpired();
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

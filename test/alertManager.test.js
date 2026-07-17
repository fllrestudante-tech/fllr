const test = require("node:test");
const assert = require("node:assert/strict");
const { createAlertManager, formatMessage, formatSummaryMessage } = require("../lib/alertManager");

function fakeSender() {
  const sent = [];
  const sender = async (text) => {
    sent.push(text);
    return { sent: true };
  };
  sender.sent = sent;
  return sender;
}

test("formatMessage: prefixa com emoji + severidade", () => {
  assert.equal(formatMessage("ERROR", "coletor caiu"), "🔴 [ERROR] coletor caiu");
});

test("formatSummaryMessage: inclui contador e janela em minutos", () => {
  const msg = formatSummaryMessage("ERROR", "coletor caiu", 17, 15 * 60 * 1000);
  assert.equal(msg, "🔴 [ERROR] coletor caiu -- 17 vezes nos últimos 15min");
});

test("fire: primeira ocorrência manda na hora", async () => {
  const sender = fakeSender();
  const manager = createAlertManager({ windowMs: 1000, now: () => 0, sender });
  await manager.fire("bybit_collector", "ERROR", "caiu");
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0], "🔴 [ERROR] caiu");
});

test("fire: repetições dentro da janela não mandam nada novo (deduplicado)", async () => {
  let t = 0;
  const sender = fakeSender();
  const manager = createAlertManager({ windowMs: 1000, now: () => t, sender });
  await manager.fire("bybit_collector", "ERROR", "caiu");
  t = 100;
  await manager.fire("bybit_collector", "ERROR", "caiu");
  t = 500;
  await manager.fire("bybit_collector", "ERROR", "caiu");
  assert.equal(sender.sent.length, 1); // só o primeiro
});

test("flush: depois que a janela expira, manda um resumo com o contador (exemplo do usuário: 'caiu 17 vezes')", async () => {
  let t = 0;
  const sender = fakeSender();
  const manager = createAlertManager({ windowMs: 1000, now: () => t, sender });
  for (let i = 0; i < 17; i++) {
    await manager.fire("bybit_collector", "ERROR", "Collector Bybit caiu");
    t += 10;
  }
  t = 2000; // janela expirou
  const expired = await manager.flush();
  assert.equal(expired.length, 1);
  assert.equal(sender.sent.length, 2); // 1 alerta original + 1 resumo
  assert.ok(sender.sent[1].includes("17 vezes"));
});

test("flush: bucket que nunca repetiu (count=1) não gera resumo extra", async () => {
  let t = 0;
  const sender = fakeSender();
  const manager = createAlertManager({ windowMs: 1000, now: () => t, sender });
  await manager.fire("fear_greed_collector", "INFO", "atualizado");
  t = 2000;
  await manager.flush();
  assert.equal(sender.sent.length, 1); // só o original, nenhum resumo
});

test("fire: sem db configurado, não quebra (histórico é opcional)", async () => {
  const sender = fakeSender();
  const manager = createAlertManager({ windowMs: 1000, now: () => 0, sender }); // sem db
  await assert.doesNotReject(manager.fire("bybit_collector", "ERROR", "caiu"));
});

test("fire: com db configurado, grava no histórico", async () => {
  let t = 0;
  const sender = fakeSender();
  const historyInserts = [];
  const fakeDb = { prepare: () => ({ run: (params) => historyInserts.push(params) }) };
  const manager = createAlertManager({ windowMs: 1000, now: () => t, sender, db: fakeDb });
  await manager.fire("bybit_collector", "ERROR", "caiu");
  assert.equal(historyInserts.length, 1);
  assert.equal(historyInserts[0].severity, "ERROR");
  assert.equal(historyInserts[0].source, "bybit_collector");
});

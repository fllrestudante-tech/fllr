const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventBus } = require("../../lib/infra/eventBus");

test("emit: chama o handler inscrito com uuid, payload e occurredAt", () => {
  const bus = createEventBus();
  let received = null;
  bus.on("candle.closed", (event) => {
    received = event;
  });

  bus.emit("candle.closed", { symbol: "BTCUSDT" });

  assert.ok(received.uuid);
  assert.deepEqual(received.payload, { symbol: "BTCUSDT" });
  assert.ok(received.occurredAt);
  assert.equal(received.eventName, "candle.closed");
});

test("emit: múltiplos listeners do mesmo evento são todos chamados", () => {
  const bus = createEventBus();
  let a = false;
  let b = false;
  bus.on("funding.updated", () => (a = true));
  bus.on("funding.updated", () => (b = true));

  bus.emit("funding.updated", {});

  assert.equal(a, true);
  assert.equal(b, true);
});

test("emit: listener de outro evento não é chamado", () => {
  const bus = createEventBus();
  let called = false;
  bus.on("oi.updated", () => (called = true));

  bus.emit("candle.closed", {});

  assert.equal(called, false);
});

test("emit: persist injetado é chamado com o evento completo", () => {
  const persisted = [];
  const bus = createEventBus({ persist: (event) => persisted.push(event) });

  bus.emit("telegram.message.received", { channel: "X" });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].eventName, "telegram.message.received");
  assert.deepEqual(persisted[0].payload, { channel: "X" });
});

test("emit: sem persist injetado, não lança erro", () => {
  const bus = createEventBus();
  assert.doesNotThrow(() => bus.emit("candle.closed", {}));
});

test("emit: retorna o evento gerado", () => {
  const bus = createEventBus();
  const event = bus.emit("signal.generated", { symbol: "BTCUSDT" });
  assert.equal(event.eventName, "signal.generated");
  assert.ok(event.uuid);
});

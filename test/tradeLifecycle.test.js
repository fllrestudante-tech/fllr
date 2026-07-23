const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, isTimeStop, isSignalReversal, REASONS } = require("../lib/tradeLifecycle");

const config = { maxHoldMinutes: 120 };

test("isTimeStop: false sem posição aberta", () => {
  assert.equal(isTimeStop({ isOpened: false, openedAt: 0 }, config, Date.now()), false);
});

test("isTimeStop: false sem openedAt (estado antigo/corrompido)", () => {
  assert.equal(isTimeStop({ isOpened: true, openedAt: null }, config, Date.now()), false);
});

test("isTimeStop: false dentro do prazo", () => {
  const now = 1_000_000_000;
  const openedAt = now - 60 * 60 * 1000; // 1h atrás, limite é 120min
  assert.equal(isTimeStop({ isOpened: true, openedAt }, config, now), false);
});

test("isTimeStop: true exatamente no limite", () => {
  const now = 1_000_000_000;
  const openedAt = now - config.maxHoldMinutes * 60 * 1000;
  assert.equal(isTimeStop({ isOpened: true, openedAt }, config, now), true);
});

test("isTimeStop: true além do limite", () => {
  const now = 1_000_000_000;
  const openedAt = now - (config.maxHoldMinutes + 30) * 60 * 1000;
  assert.equal(isTimeStop({ isOpened: true, openedAt }, config, now), true);
});

test("isSignalReversal: false sem posição aberta", () => {
  assert.equal(isSignalReversal({ isOpened: false, side: null }, { signal: "sell" }), false);
});

test("isSignalReversal: true quando posição Buy e sinal vira sell", () => {
  assert.equal(isSignalReversal({ isOpened: true, side: "Buy" }, { signal: "sell" }), true);
});

test("isSignalReversal: true quando posição Sell e sinal vira buy", () => {
  assert.equal(isSignalReversal({ isOpened: true, side: "Sell" }, { signal: "buy" }), true);
});

test("isSignalReversal: false quando sinal mantém a mesma direção", () => {
  assert.equal(isSignalReversal({ isOpened: true, side: "Buy" }, { signal: "buy" }), false);
  assert.equal(isSignalReversal({ isOpened: true, side: "Buy" }, { signal: "wait" }), false);
});

test("evaluate: reason null sem posição aberta", () => {
  const result = evaluate({ botState: { isOpened: false }, analysis: { signal: "buy" }, now: Date.now(), config });
  assert.equal(result.reason, null);
});

test("evaluate: time_stop tem prioridade sobre signal_reversal", () => {
  const now = 1_000_000_000;
  const botState = { isOpened: true, side: "Buy", openedAt: now - (config.maxHoldMinutes + 1) * 60 * 1000 };
  const result = evaluate({ botState, analysis: { signal: "sell" }, now, config });
  assert.equal(result.reason, REASONS.TIME_STOP);
});

test("evaluate: signal_reversal quando dentro do prazo mas sinal reverteu", () => {
  const now = 1_000_000_000;
  const botState = { isOpened: true, side: "Buy", openedAt: now - 5 * 60 * 1000 };
  const result = evaluate({ botState, analysis: { signal: "sell" }, now, config });
  assert.equal(result.reason, REASONS.SIGNAL_REVERSAL);
});

test("evaluate: reason null quando dentro do prazo e sinal não reverteu", () => {
  const now = 1_000_000_000;
  const botState = { isOpened: true, side: "Buy", openedAt: now - 5 * 60 * 1000 };
  const result = evaluate({ botState, analysis: { signal: "wait" }, now, config });
  assert.equal(result.reason, null);
});

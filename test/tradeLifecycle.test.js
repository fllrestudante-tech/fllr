const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluate,
  isTimeStop,
  isSignalReversal,
  isBreakEvenDue,
  isTrailingActivationDue,
  computeTrailingActivePrice,
  REASONS,
} = require("../lib/tradeLifecycle");

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

// --- isBreakEvenDue (Fase D3) ---

function openBuyState(overrides = {}) {
  return { isOpened: true, side: "Buy", entryPrice: 100, stopLossPrice: 97, breakEvenApplied: false, ...overrides };
}

test("isBreakEvenDue: false sem posição aberta", () => {
  assert.equal(isBreakEvenDue({ isOpened: false }, { price: 200 }), false);
});

test("isBreakEvenDue: false se já foi aplicado", () => {
  assert.equal(isBreakEvenDue(openBuyState({ breakEvenApplied: true }), { price: 200 }), false);
});

test("isBreakEvenDue: false sem stopLossPrice/entryPrice (estado antigo/corrompido)", () => {
  assert.equal(isBreakEvenDue({ isOpened: true, side: "Buy", stopLossPrice: null, entryPrice: null }, { price: 200 }), false);
});

test("isBreakEvenDue: compra -- false antes de +1R", () => {
  // R = 100-97 = 3, preço só andou 2 a favor
  assert.equal(isBreakEvenDue(openBuyState(), { price: 102 }), false);
});

test("isBreakEvenDue: compra -- true exatamente em +1R", () => {
  assert.equal(isBreakEvenDue(openBuyState(), { price: 103 }), true);
});

test("isBreakEvenDue: compra -- true além de +1R", () => {
  assert.equal(isBreakEvenDue(openBuyState(), { price: 110 }), true);
});

test("isBreakEvenDue: venda -- true exatamente em +1R", () => {
  const state = { isOpened: true, side: "Sell", entryPrice: 100, stopLossPrice: 103, breakEvenApplied: false };
  assert.equal(isBreakEvenDue(state, { price: 97 }), true);
});

test("isBreakEvenDue: venda -- false antes de +1R", () => {
  const state = { isOpened: true, side: "Sell", entryPrice: 100, stopLossPrice: 103, breakEvenApplied: false };
  assert.equal(isBreakEvenDue(state, { price: 99 }), false);
});

// --- isTrailingActivationDue / computeTrailingActivePrice (Fase D4) ---

function trailingReadyState(overrides = {}) {
  return { isOpened: true, side: "Buy", entryPrice: 100, breakEvenApplied: true, trailingActivated: false, ...overrides };
}

test("computeTrailingActivePrice: compra soma a distância, venda subtrai", () => {
  assert.equal(computeTrailingActivePrice({ side: "Buy", entryPrice: 100 }, 5), 105);
  assert.equal(computeTrailingActivePrice({ side: "Sell", entryPrice: 100 }, 5), 95);
});

test("isTrailingActivationDue: false se break even ainda não foi aplicado (pré-requisito)", () => {
  assert.equal(isTrailingActivationDue(trailingReadyState({ breakEvenApplied: false }), { price: 200 }, 5), false);
});

test("isTrailingActivationDue: false se já ativado", () => {
  assert.equal(isTrailingActivationDue(trailingReadyState({ trailingActivated: true }), { price: 200 }, 5), false);
});

test("isTrailingActivationDue: false sem distância válida", () => {
  assert.equal(isTrailingActivationDue(trailingReadyState(), { price: 200 }, 0), false);
  assert.equal(isTrailingActivationDue(trailingReadyState(), { price: 200 }, null), false);
});

test("isTrailingActivationDue: compra -- false antes do activePrice", () => {
  assert.equal(isTrailingActivationDue(trailingReadyState(), { price: 104 }, 5), false);
});

test("isTrailingActivationDue: compra -- true no activePrice ou além", () => {
  assert.equal(isTrailingActivationDue(trailingReadyState(), { price: 105 }, 5), true);
  assert.equal(isTrailingActivationDue(trailingReadyState(), { price: 110 }, 5), true);
});

test("isTrailingActivationDue: venda -- true no activePrice ou além", () => {
  const state = trailingReadyState({ side: "Sell" });
  assert.equal(isTrailingActivationDue(state, { price: 96 }, 5), false);
  assert.equal(isTrailingActivationDue(state, { price: 95 }, 5), true);
});

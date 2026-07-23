const test = require("node:test");
const assert = require("node:assert/strict");
const risk = require("../lib/risk");
const config = require("../config");

function freshState(overrides = {}) {
  return {
    isOpened: false,
    side: null,
    lastTradeTime: 0,
    dailyLoss: 0,
    consecutiveLosses: 0,
    circuitBreakerUntil: null,
    ...overrides,
  };
}

test("canExecute: bloqueia com circuit_breaker enquanto circuitBreakerUntil não passou", () => {
  const state = freshState({ circuitBreakerUntil: Date.now() + 60000 });
  const result = risk.canExecute("buy", state);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "circuit_breaker");
});

test("canExecute: libera depois que circuitBreakerUntil passou", () => {
  const state = freshState({ circuitBreakerUntil: Date.now() - 1000 });
  const result = risk.canExecute("buy", state);
  assert.equal(result.ok, true);
});

test("canExecute: circuitBreakerUntil null não bloqueia (estado padrão/novo)", () => {
  const state = freshState({ circuitBreakerUntil: null });
  const result = risk.canExecute("buy", state);
  assert.equal(result.ok, true);
});

test("registerTradeResult: zera consecutiveLosses em trade lucrativo", () => {
  const state = freshState({ consecutiveLosses: 2 });
  risk.registerTradeResult(state, 0.01);
  assert.equal(state.consecutiveLosses, 0);
});

test("registerTradeResult: incrementa consecutiveLosses em trade perdedor", () => {
  const state = freshState({ consecutiveLosses: 1 });
  risk.registerTradeResult(state, -0.005);
  assert.equal(state.consecutiveLosses, 2);
  assert.ok(state.dailyLoss > 0);
});

test("registerTradeResult: dispara circuit breaker ao atingir circuitBreakerLossStreak", () => {
  const state = freshState({ consecutiveLosses: config.circuitBreakerLossStreak - 1 });
  const before = Date.now();
  risk.registerTradeResult(state, -0.005);
  assert.equal(state.consecutiveLosses, 0); // reinicia depois de disparar
  assert.ok(state.circuitBreakerUntil >= before + config.circuitBreakerPauseMs);
});

test("registerTradeResult: dispara circuit breaker ao atingir circuitBreakerDailyDrawdownPct mesmo sem streak", () => {
  const state = freshState({ dailyLoss: config.circuitBreakerDailyDrawdownPct - 0.001, consecutiveLosses: 0 });
  risk.registerTradeResult(state, -0.01);
  assert.ok(state.dailyLoss >= config.circuitBreakerDailyDrawdownPct);
  assert.ok(state.circuitBreakerUntil !== null);
});

test("registerTradeResult: não dispara circuit breaker abaixo dos dois limiares", () => {
  const state = freshState();
  risk.registerTradeResult(state, -0.001);
  assert.equal(state.circuitBreakerUntil, null);
});

test("registerVolatilityCheck: dispara pausa quando regime é HIGH", () => {
  const state = freshState();
  const now = Date.now();
  risk.registerVolatilityCheck(state, "HIGH", now);
  assert.equal(state.circuitBreakerUntil, now + config.circuitBreakerPauseMs);
});

test("registerVolatilityCheck: não dispara pausa em regime NORMAL/LOW", () => {
  const state = freshState();
  risk.registerVolatilityCheck(state, "NORMAL", Date.now());
  assert.equal(state.circuitBreakerUntil, null);
  risk.registerVolatilityCheck(state, "LOW", Date.now());
  assert.equal(state.circuitBreakerUntil, null);
});

// --- planOrder: tpLevels (Fase D5) ---

test("planOrder: calcula tpLevels a partir de config.tpLevels, preço absoluto por R e qty por qtyPct (compra)", () => {
  const originalLevels = config.tpLevels;
  try {
    config.tpLevels = [
      { r: 1, qtyPct: 0.3 },
      { r: 2, qtyPct: 0.3 },
    ];
    const plan = risk.planOrder({
      side: "buy",
      price: 100,
      atr: 0, // força uso do stopLossPct puro, sem interferência do ATR
      equity: 10000,
      params: { stopLossPct: 0.03 },
      instrumentInfo: null,
    });
    // R = 100 * 0.03 = 3
    assert.equal(plan.tpLevels.length, 2);
    assert.ok(Math.abs(plan.tpLevels[0].price - 103) < 1e-6); // 100 + 1*3
    assert.ok(Math.abs(plan.tpLevels[1].price - 106) < 1e-6); // 100 + 2*3
    assert.ok(Math.abs(plan.tpLevels[0].qty - plan.qty * 0.3) < 1e-6);
  } finally {
    config.tpLevels = originalLevels;
  }
});

test("planOrder: tpLevels na venda sobem preço pro lado oposto (R subtrai)", () => {
  const originalLevels = config.tpLevels;
  try {
    config.tpLevels = [{ r: 1, qtyPct: 0.3 }];
    const plan = risk.planOrder({
      side: "sell",
      price: 100,
      atr: 0,
      equity: 10000,
      params: { stopLossPct: 0.03 },
      instrumentInfo: null,
    });
    assert.ok(Math.abs(plan.tpLevels[0].price - 97) < 1e-6); // 100 - 1*3
  } finally {
    config.tpLevels = originalLevels;
  }
});

test("planOrder: array vazio em config.tpLevels retorna tpLevels vazio, sem quebrar", () => {
  const originalLevels = config.tpLevels;
  try {
    config.tpLevels = [];
    const plan = risk.planOrder({ side: "buy", price: 100, atr: 0, equity: 10000, params: { stopLossPct: 0.03 }, instrumentInfo: null });
    assert.deepEqual(plan.tpLevels, []);
  } finally {
    config.tpLevels = originalLevels;
  }
});

test("registerVolatilityCheck: HIGH persistente reestende a pausa (rolling)", () => {
  const state = freshState();
  const t1 = Date.now();
  risk.registerVolatilityCheck(state, "HIGH", t1);
  const firstUntil = state.circuitBreakerUntil;
  const t2 = t1 + 60000;
  risk.registerVolatilityCheck(state, "HIGH", t2);
  assert.ok(state.circuitBreakerUntil > firstUntil);
});

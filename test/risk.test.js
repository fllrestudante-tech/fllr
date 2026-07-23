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

test("registerVolatilityCheck: HIGH persistente reestende a pausa (rolling)", () => {
  const state = freshState();
  const t1 = Date.now();
  risk.registerVolatilityCheck(state, "HIGH", t1);
  const firstUntil = state.circuitBreakerUntil;
  const t2 = t1 + 60000;
  risk.registerVolatilityCheck(state, "HIGH", t2);
  assert.ok(state.circuitBreakerUntil > firstUntil);
});

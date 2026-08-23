const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldCallAi } = require("../../lib/aiGateway/decisionCyclePolicy");

const fakeConfig = { ai: { minCallIntervalMs: 5 * 60 * 1000, shadowIntervalMs: 15 * 60 * 1000 } };

function fakeBotState(overrides = {}) {
  return { lastAiCallAt: 0, lastAiContextHash: null, ...overrides };
}

test("shouldCallAi: nunca chama antes do piso mínimo (minCallIntervalMs), mesmo com sinal buy/sell", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 60_000 }); // só 1min desde a última chamada
  const decision = shouldCallAi({ analysis: { signal: "buy" }, botState, contextHash: "abc", config: fakeConfig, now });
  assert.equal(decision.call, false);
  assert.equal(decision.reason, "min_interval_not_elapsed");
});

test("shouldCallAi: chama em sinal buy/sell depois do piso mínimo, mesmo sem heartbeat vencido", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 6 * 60_000 }); // 6min, acima do piso de 5min
  const decision = shouldCallAi({ analysis: { signal: "buy" }, botState, contextHash: "abc", config: fakeConfig, now });
  assert.equal(decision.call, true);
  assert.equal(decision.reason, "quant_signal");
});

test("shouldCallAi: sinal wait sem heartbeat vencido não chama (no_relevant_context)", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 6 * 60_000 }); // acima do piso, abaixo do heartbeat (15min)
  const decision = shouldCallAi({ analysis: { signal: "wait" }, botState, contextHash: "abc", config: fakeConfig, now });
  assert.equal(decision.call, false);
  assert.equal(decision.reason, "no_relevant_context");
});

test("shouldCallAi: sinal wait com heartbeat vencido (>=15min) chama mesmo sem sinal", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 16 * 60_000 });
  const decision = shouldCallAi({ analysis: { signal: "wait" }, botState, contextHash: "abc", config: fakeConfig, now });
  assert.equal(decision.call, true);
  assert.equal(decision.reason, "heartbeat");
});

test("shouldCallAi: sinal buy com contexto idêntico ao último e sem heartbeat vencido é pulado (cost-guard)", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 6 * 60_000, lastAiContextHash: "same-hash" });
  const decision = shouldCallAi({ analysis: { signal: "buy" }, botState, contextHash: "same-hash", config: fakeConfig, now });
  assert.equal(decision.call, false);
  assert.equal(decision.reason, "context_unchanged");
});

test("shouldCallAi: contexto idêntico mas heartbeat vencido chama mesmo assim (nunca fica cego por horas)", () => {
  const now = 1_000_000;
  const botState = fakeBotState({ lastAiCallAt: now - 16 * 60_000, lastAiContextHash: "same-hash" });
  const decision = shouldCallAi({ analysis: { signal: "wait" }, botState, contextHash: "same-hash", config: fakeConfig, now });
  assert.equal(decision.call, true);
  assert.equal(decision.reason, "heartbeat");
});

test("shouldCallAi: primeira chamada de sempre (lastAiCallAt=0) não é bloqueada pelo piso mínimo", () => {
  const now = Date.now();
  const botState = fakeBotState({ lastAiCallAt: 0 });
  const decision = shouldCallAi({ analysis: { signal: "sell" }, botState, contextHash: "x", config: fakeConfig, now });
  assert.equal(decision.call, true);
  assert.equal(decision.reason, "quant_signal");
});

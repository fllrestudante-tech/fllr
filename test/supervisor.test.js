const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSupervisorState,
  recordSpawn,
  recordExit,
  markStopped,
  touchTick,
} = require("../lib/supervisor");

test("createSupervisorState: inicializa cada filho parado, sem restarts", () => {
  const state = createSupervisorState(["bot", "bybit_collector"]);
  assert.equal(state.bot.status, "stopped");
  assert.equal(state.bot.pid, null);
  assert.equal(state.bot.consecutiveRestarts, 0);
  assert.equal(state.bot.totalRestarts, 0);
  assert.equal(state.bybit_collector.status, "stopped");
  assert.equal(state._meta.lastTickAt, null);
});

test("recordSpawn: marca como running com pid e startedAt", () => {
  const state = createSupervisorState(["bot"]);
  const now = Date.now();
  recordSpawn(state, "bot", 1234, now);
  assert.equal(state.bot.status, "running");
  assert.equal(state.bot.pid, 1234);
  assert.equal(state.bot.startedAt, new Date(now).toISOString());
});

test("recordExit: processo que caiu rápido (uptime < 1min) incrementa consecutiveRestarts e cresce o backoff", () => {
  const state = createSupervisorState(["bot"]);
  const t0 = 1000000;
  recordSpawn(state, "bot", 111, t0);

  const result = recordExit(state, "bot", { code: 1, signal: null }, t0 + 5000); // caiu em 5s
  assert.equal(result.consecutiveRestarts, 1);
  assert.equal(result.delayMs, 10000); // baseMs(5000) * 2^1
  assert.equal(state.bot.status, "crashed");
  assert.equal(state.bot.pid, null);
  assert.equal(state.bot.totalRestarts, 1);
  assert.equal(state.bot.lastExit.code, 1);
  assert.equal(state.bot.lastExit.uptimeMs, 5000);

  // segunda queda rápida em seguida -- backoff cresce mais
  recordSpawn(state, "bot", 112, t0 + 15000);
  const result2 = recordExit(state, "bot", { code: 1, signal: null }, t0 + 17000);
  assert.equal(result2.consecutiveRestarts, 2);
  assert.equal(result2.delayMs, 20000); // baseMs(5000) * 2^2
  assert.equal(state.bot.totalRestarts, 2);
});

test("recordExit: processo que ficou de pé mais de 1min reseta consecutiveRestarts (volta ao delay base)", () => {
  const state = createSupervisorState(["bot"]);
  const t0 = 1000000;
  recordSpawn(state, "bot", 111, t0);
  recordExit(state, "bot", { code: 1 }, t0 + 5000); // 1ª queda rápida
  assert.equal(state.bot.consecutiveRestarts, 1);

  recordSpawn(state, "bot", 222, t0 + 20000);
  const result = recordExit(state, "bot", { code: 0 }, t0 + 20000 + 90000); // ficou de pé 90s
  assert.equal(result.consecutiveRestarts, 0);
  assert.equal(result.delayMs, 5000); // baseMs sem penalidade
  assert.equal(state.bot.totalRestarts, 2); // total continua contando, mesmo resetando o consecutivo
});

test("recordExit: backoff nunca ultrapassa o teto de 5min mesmo com muitas quedas seguidas", () => {
  const state = createSupervisorState(["bot"]);
  let t = 1000000;
  recordSpawn(state, "bot", 1, t);
  let result;
  for (let i = 0; i < 10; i++) {
    t += 1000;
    result = recordExit(state, "bot", { code: 1 }, t);
    t += 1000;
    recordSpawn(state, "bot", i + 2, t);
  }
  assert.ok(result.delayMs <= 300000);
  assert.equal(result.delayMs, 300000);
});

test("markStopped: desligamento pedido não conta como restart", () => {
  const state = createSupervisorState(["bot"]);
  const t0 = 1000000;
  recordSpawn(state, "bot", 111, t0);
  markStopped(state, "bot", t0 + 2000);
  assert.equal(state.bot.status, "stopped");
  assert.equal(state.bot.pid, null);
  assert.equal(state.bot.totalRestarts, 0);
  assert.equal(state.bot.consecutiveRestarts, 0);
  assert.equal(state.bot.lastExit.signal, "SIGINT");
});

test("touchTick: grava lastTickAt em _meta", () => {
  const state = createSupervisorState(["bot"]);
  const now = 1234567890;
  touchTick(state, now);
  assert.equal(state._meta.lastTickAt, new Date(now).toISOString());
});

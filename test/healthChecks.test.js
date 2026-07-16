const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  checkBybit,
  checkBacktest,
  checkTelegramRadar,
  checkDatabase,
  checkCollector,
  checkFearGreed,
  checkBtcDominance,
  checkKnowledgeCollector,
  checkSupervisor,
} = require("../lib/healthChecks");
const { openDb } = require("../lib/infra/db");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${name}`);
}

test("checkBybit: chamada rápida com sucesso reporta ok com latência", async () => {
  const fakeClient = { getKlines: async () => [] };
  const result = await checkBybit(fakeClient);
  assert.equal(result.status, "ok");
  assert.equal(typeof result.details.latencyMs, "number");
});

test("checkBybit: latência acima do limite reporta degraded", async () => {
  const fakeClient = { getKlines: async () => [] };
  const result = await checkBybit(fakeClient, { degradedLatencyMs: -1 }); // qualquer latência >= 0 excede -1
  assert.equal(result.status, "degraded");
});

test("checkBybit: falha na chamada reporta down", async () => {
  const fakeClient = {
    getKlines: async () => {
      throw new Error("ENOTFOUND");
    },
  };
  const result = await checkBybit(fakeClient);
  assert.equal(result.status, "down");
  assert.equal(result.details.error, "ENOTFOUND");
});

test("checkBacktest: arquivo inexistente reporta not_implemented", () => {
  const result = checkBacktest(tmpFile("nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkBacktest: histórico recente reporta ok", () => {
  const file = tmpFile("tuning-recente.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ history: [{ ranAt: new Date(now - 1000).toISOString(), promoted: true }] }));
  const result = checkBacktest(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
  assert.equal(result.details.promoted, true);
});

test("checkBacktest: histórico velho (mais de 2x o intervalo configurado) reporta degraded", () => {
  const file = tmpFile("tuning-velho.json");
  const now = Date.now();
  const dezesseisHorasAtras = now - 16 * 60 * 60 * 1000; // config default backtestIntervalHours=6 -> tolerância 12h
  fs.writeFileSync(file, JSON.stringify({ history: [{ ranAt: new Date(dezesseisHorasAtras).toISOString(), promoted: false }] }));
  const result = checkBacktest(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "degraded");
});

test("checkBacktest: arquivo corrompido reporta down", () => {
  const file = tmpFile("tuning-corrompido.json");
  fs.writeFileSync(file, "{ nao é json");
  const result = checkBacktest(file);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkTelegramRadar: arquivo de heartbeat inexistente reporta disabled (coletor manual, não supervisionado)", () => {
  const result = checkTelegramRadar(tmpFile("nao-existe.json"));
  assert.equal(result.status, "disabled");
});

test("checkTelegramRadar: heartbeat recente reporta ok", () => {
  const file = tmpFile("health-recente.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ lastHeartbeatAt: new Date(now - 1000).toISOString(), status: "connected" }));
  const result = checkTelegramRadar(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkTelegramRadar: heartbeat velho (mais de 5min) reporta stopped, não down (coletor manual, staleness não é alarme)", () => {
  const file = tmpFile("health-velho.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ lastHeartbeatAt: new Date(now - 10 * 60 * 1000).toISOString() }));
  const result = checkTelegramRadar(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "stopped");
});

test("checkTelegramRadar: arquivo corrompido reporta down (isso sim é anômalo, mesmo sendo manual)", () => {
  const file = tmpFile("health-corrompido.json");
  fs.writeFileSync(file, "{ nao e json");
  const result = checkTelegramRadar(file);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkDatabase: arquivo inexistente reporta not_implemented", () => {
  const result = checkDatabase(tmpFile("market-nao-existe.db"));
  assert.equal(result.status, "not_implemented");
});

test("checkDatabase: banco válido (com migrações aplicadas) reporta ok", () => {
  const dbPath = tmpFile("market-valido.db");
  const db = openDb(dbPath);
  db.close();

  const result = checkDatabase(dbPath);
  fs.unlinkSync(dbPath);
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });

  assert.equal(result.status, "ok");
});

test("checkDatabase: arquivo corrompido (não é SQLite) reporta down", () => {
  const dbPath = tmpFile("market-corrompido.db");
  fs.writeFileSync(dbPath, "isso nao e um banco sqlite");

  const result = checkDatabase(dbPath);
  fs.unlinkSync(dbPath);

  assert.equal(result.status, "down");
});

test("checkCollector: arquivo inexistente reporta not_implemented", () => {
  const result = checkCollector(tmpFile("collector-nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkCollector: heartbeat recente sem falhas reporta ok", () => {
  const file = tmpFile("collector-ok.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({ lastHeartbeatAt: new Date(now - 1000).toISOString(), metrics: { candles: { consecutiveFailures: 0 } } })
  );
  const result = checkCollector(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkCollector: heartbeat velho (mais de 5min) reporta down", () => {
  const file = tmpFile("collector-velho.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ lastHeartbeatAt: new Date(now - 10 * 60 * 1000).toISOString(), metrics: {} }));
  const result = checkCollector(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkCollector: domínio com 3+ falhas consecutivas reporta degraded mesmo com heartbeat fresco", () => {
  const file = tmpFile("collector-degradado.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
      metrics: { candles: { consecutiveFailures: 0 }, funding: { consecutiveFailures: 4 } },
    })
  );
  const result = checkCollector(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "degraded");
  assert.deepEqual(result.details.failingDomains, ["funding"]);
});

test("checkFearGreed: arquivo inexistente reporta not_implemented", () => {
  const result = checkFearGreed(tmpFile("fear-greed-nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkFearGreed: heartbeat recente sem falhas reporta ok", () => {
  const file = tmpFile("fear-greed-ok.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({ lastHeartbeatAt: new Date(now - 1000).toISOString(), metrics: { fear_greed: { consecutiveFailures: 0 } } })
  );
  const result = checkFearGreed(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkBtcDominance: arquivo inexistente reporta not_implemented", () => {
  const result = checkBtcDominance(tmpFile("btc-dominance-nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkBtcDominance: heartbeat recente sem falhas reporta ok", () => {
  const file = tmpFile("btc-dominance-ok.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({ lastHeartbeatAt: new Date(now - 1000).toISOString(), metrics: { btc_dominance: { consecutiveFailures: 0 } } })
  );
  const result = checkBtcDominance(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkKnowledgeCollector: arquivo inexistente reporta not_implemented", () => {
  const result = checkKnowledgeCollector(tmpFile("knowledge-nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkKnowledgeCollector: heartbeat recente sem falhas reporta ok", () => {
  const file = tmpFile("knowledge-ok.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      lastHeartbeatAt: new Date(now - 1000).toISOString(),
      metrics: { coinmarketcal: { consecutiveFailures: 0 }, fred: { consecutiveFailures: 0 }, fomc_calendar: { consecutiveFailures: 0 } },
    })
  );
  const result = checkKnowledgeCollector(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
});

test("checkSupervisor: arquivo inexistente reporta not_implemented", () => {
  const result = checkSupervisor(tmpFile("supervisor-nao-existe.json"));
  assert.equal(result.status, "not_implemented");
});

test("checkSupervisor: tick recente reporta ok e resume status dos filhos", () => {
  const file = tmpFile("supervisor-ok.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      bot: { status: "running" },
      bybit_collector: { status: "crashed" },
      _meta: { lastTickAt: new Date(now - 1000).toISOString() },
    })
  );
  const result = checkSupervisor(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.details.children, { bot: "running", bybit_collector: "crashed" });
});

test("checkSupervisor: tick velho (mais de 90s) reporta down", () => {
  const file = tmpFile("supervisor-velho.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ bot: { status: "running" }, _meta: { lastTickAt: new Date(now - 5 * 60 * 1000).toISOString() } }));
  const result = checkSupervisor(file, now);
  fs.unlinkSync(file);
  assert.equal(result.status, "down");
});

test("checkSupervisor: state.json sem _meta.lastTickAt reporta degraded", () => {
  const file = tmpFile("supervisor-sem-meta.json");
  fs.writeFileSync(file, JSON.stringify({ bot: { status: "running" } }));
  const result = checkSupervisor(file);
  fs.unlinkSync(file);
  assert.equal(result.status, "degraded");
});

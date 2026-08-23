const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openDb } = require("../lib/infra/db");
const { computeRealContext, recordPrediction, reconcileDue, getLatestContextHash } = require("../lib/shadowEvaluation");

function tmpDbPath() {
  return path.join(os.tmpdir(), `bot-cripto10-shadoweval-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanup(dbPath) {
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + "-wal", { force: true });
  fs.rmSync(dbPath + "-shm", { force: true });
}

// Espelha insertCandles de test/candleHistory.test.js -- mesma tabela, mesmas
// colunas obrigatórias (uuid/exchange/recorded_at, não só OHLCV).
function insertCandles(db, { symbol = "SOLUSDT", interval = "1", candles }) {
  const insert = db.prepare(
    "INSERT INTO candles (uuid, exchange, symbol, interval, open_time, open, high, low, close, volume, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  );
  for (const c of candles) {
    insert.run(`uuid-${symbol}-${c.openTime}`, "bybit", symbol, interval, c.openTime, c.open, c.high, c.low, c.close, c.volume ?? 10, new Date(c.openTime).toISOString());
  }
}

function fakeAiResult(overrides = {}) {
  return {
    state: "AI_BULLISH",
    score: 68,
    confidence: 100,
    reasons: ["tendência de alta", "Risco sinalizado pela IA: liquidez média"],
    ai: {
      provider: "openai",
      model: "gpt-4o-mini",
      riskFlags: ["liquidez média"],
      parseError: null,
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      contextHash: "hash-abc123",
    },
    ...overrides,
  };
}

function insertPrediction(db, overrides = {}) {
  const nowIso = new Date().toISOString();
  const row = {
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    context_hash: "hash-xyz",
    symbol: "SOLUSDT",
    interval: "1",
    t0: nowIso,
    t0_ms: Date.now(),
    price_t0: 150,
    is_valid_prediction: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    bias: "bullish",
    state: "AI_BULLISH",
    score: 70,
    confidence: 100,
    risk_flags: "[]",
    rationale: "teste",
    created_at: nowIso,
    updated_at: nowIso,
    ...overrides,
  };
  const info = db
    .prepare(
      `INSERT INTO ai_shadow_predictions
         (request_id, context_hash, symbol, interval, t0, t0_ms, price_t0, is_valid_prediction,
          provider, model, bias, state, score, confidence, risk_flags, rationale,
          created_at, updated_at)
       VALUES (@request_id, @context_hash, @symbol, @interval, @t0, @t0_ms, @price_t0, @is_valid_prediction,
               @provider, @model, @bias, @state, @score, @confidence, @risk_flags, @rationale,
               @created_at, @updated_at)`
    )
    .run(row);
  return { id: info.lastInsertRowid, ...row };
}

test("recordPrediction: insere linha com os 4 horizontes pendentes, is_valid_prediction=1 e campos de identidade corretos", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const aiResult = fakeAiResult();

  const inserted = recordPrediction(db, { aiResult, price: 150.23, symbol: "SOLUSDT", interval: "1" });
  const row = db.prepare("SELECT * FROM ai_shadow_predictions WHERE id = ?").get(inserted.id);
  db.close();
  cleanup(dbPath);

  assert.equal(row.request_id, aiResult.ai.requestId);
  assert.equal(row.context_hash, aiResult.ai.contextHash);
  assert.equal(row.price_t0, 150.23);
  assert.equal(row.is_valid_prediction, 1);
  assert.equal(row.bias, "bullish");
  assert.equal(row.state, "AI_BULLISH");
  assert.equal(row.reconciled_t15, 0);
  assert.equal(row.reconciled_t30, 0);
  assert.equal(row.reconciled_t60, 0);
  assert.equal(row.reconciled_t240, 0);
  assert.equal(row.price_t15, null);
  assert.deepEqual(JSON.parse(row.risk_flags), ["liquidez média"]);
});

test("recordPrediction: AI_UNAVAILABLE grava is_valid_prediction=0, nunca vira 'previsão neutral' disfarçada", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const aiResult = fakeAiResult({
    state: "AI_UNAVAILABLE",
    score: 0,
    confidence: 0,
    reasons: ["openai: sem API key configurada", "anthropic: sem API key configurada"],
    ai: { provider: null, model: null, riskFlags: undefined, parseError: null, requestId: "req-fail-1", contextHash: "hash-fail" },
  });

  const inserted = recordPrediction(db, { aiResult, price: 150, symbol: "SOLUSDT", interval: "1" });
  const row = db.prepare("SELECT * FROM ai_shadow_predictions WHERE id = ?").get(inserted.id);
  db.close();
  cleanup(dbPath);

  assert.equal(row.is_valid_prediction, 0);
  assert.equal(row.provider, null);
  assert.equal(row.bias, null);
  assert.equal(row.state, "AI_UNAVAILABLE");
});

test("reconcileDue: só o horizonte vencido preenche, os demais continuam pendentes", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const t0Ms = now - 20 * 60000; // T+15 já venceu, T+30/60/240 não

  const pred = insertPrediction(db, { t0_ms: t0Ms, price_t0: 100 });
  insertCandles(db, { candles: [{ openTime: t0Ms + 15 * 60000, open: 104, high: 106, low: 103, close: 105 }] });

  const reconciled = reconcileDue(db, { symbol: "SOLUSDT", interval: "1", now });
  const row = db.prepare("SELECT * FROM ai_shadow_predictions WHERE id = ?").get(pred.id);
  db.close();
  cleanup(dbPath);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].horizonMin, 15);
  assert.equal(row.reconciled_t15, 1);
  assert.equal(row.price_t15, 105);
  assert.equal(row.return_pct_t15, 5); // (105-100)/100 * 100
  assert.equal(row.reconciled_t30, 0);
  assert.equal(row.reconciled_t60, 0);
  assert.equal(row.reconciled_t240, 0);
});

test("reconcileDue: sem look-ahead -- candle futuro já existe (backfill), mas 'now' ainda não chegou no horizonte", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const t0Ms = Date.now();
  const nowBeforeDue = t0Ms + 10 * 60000; // T+15 ainda não venceu

  insertPrediction(db, { t0_ms: t0Ms, price_t0: 100 });
  // Candle já existe no banco pro horizonte T+15, simulando backfill adiantado
  insertCandles(db, { candles: [{ openTime: t0Ms + 15 * 60000, open: 110, high: 111, low: 109, close: 110 }] });

  const reconciled = reconcileDue(db, { symbol: "SOLUSDT", interval: "1", now: nowBeforeDue });
  const row = db.prepare("SELECT * FROM ai_shadow_predictions").get();
  db.close();
  cleanup(dbPath);

  assert.equal(reconciled.length, 0);
  assert.equal(row.reconciled_t15, 0);
  assert.equal(row.price_t15, null);
});

test("reconcileDue: horizonte vencido mas sem candle dentro da tolerância -- não lança, fica pendente pro próximo tick", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const t0Ms = now - 20 * 60000;

  insertPrediction(db, { t0_ms: t0Ms, price_t0: 100 });
  // nenhum candle inserido -- gap de dado

  assert.doesNotThrow(() => reconcileDue(db, { symbol: "SOLUSDT", interval: "1", now }));
  const row = db.prepare("SELECT * FROM ai_shadow_predictions").get();
  db.close();
  cleanup(dbPath);

  assert.equal(row.reconciled_t15, 0);
});

test("reconcileDue: idempotente -- rodar duas vezes não duplica nem corrompe o resultado já gravado", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const t0Ms = now - 20 * 60000;

  const pred = insertPrediction(db, { t0_ms: t0Ms, price_t0: 100 });
  insertCandles(db, { candles: [{ openTime: t0Ms + 15 * 60000, open: 104, high: 106, low: 103, close: 108 }] });

  const first = reconcileDue(db, { symbol: "SOLUSDT", interval: "1", now });
  const rowAfterFirst = db.prepare("SELECT * FROM ai_shadow_predictions WHERE id = ?").get(pred.id);
  const second = reconcileDue(db, { symbol: "SOLUSDT", interval: "1", now });
  const rowAfterSecond = db.prepare("SELECT * FROM ai_shadow_predictions WHERE id = ?").get(pred.id);
  db.close();
  cleanup(dbPath);

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(rowAfterFirst.price_t15, rowAfterSecond.price_t15);
  assert.equal(rowAfterFirst.return_pct_t15, rowAfterSecond.return_pct_t15);
});

test("getLatestContextHash: sem linhas devolve null; com várias, devolve a de maior t0_ms; ignora outro symbol/interval", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  assert.equal(getLatestContextHash(db, { symbol: "SOLUSDT", interval: "1" }), null);

  const base = Date.now();
  insertPrediction(db, { symbol: "SOLUSDT", interval: "1", t0_ms: base - 60000, context_hash: "hash-old" });
  insertPrediction(db, { symbol: "SOLUSDT", interval: "1", t0_ms: base, context_hash: "hash-new" });
  insertPrediction(db, { symbol: "BTCUSDT", interval: "1", t0_ms: base + 60000, context_hash: "hash-other-symbol" });

  const latest = getLatestContextHash(db, { symbol: "SOLUSDT", interval: "1" });
  db.close();
  cleanup(dbPath);

  assert.equal(latest, "hash-new");
});

test("computeRealContext: com candles reais suficientes, devolve market/structure/liquidity/fusion com state definido e price = close do último candle", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const now = Date.now();
  const startMs = now - 250 * 60000;

  const candles = [];
  for (let i = 0; i < 250; i++) {
    const openTime = startMs + i * 60000;
    const close = 100 + Math.sin(i / 10) * 2; // série com alguma variação, não flat
    candles.push({ openTime, open: close, high: close + 0.5, low: close - 0.5, close, volume: 10 });
  }
  insertCandles(db, { symbol: "SOLUSDT", interval: "1", candles });

  const result = computeRealContext(db, { symbol: "SOLUSDT", interval: "1" });
  db.close();
  cleanup(dbPath);

  assert.ok(result.market && typeof result.market.state === "string");
  assert.ok(result.structure && typeof result.structure.state === "string");
  assert.ok(result.liquidity && typeof result.liquidity.state === "string");
  assert.ok(result.fusion && typeof result.fusion.state === "string");
  assert.equal(result.price, candles[candles.length - 1].close);
  assert.ok(result.sourceDataTime);
});

test("computeRealContext: sem candles recentes, price fica null (chamador deve pular a previsão, nunca inventar preço)", () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);

  const result = computeRealContext(db, { symbol: "SOLUSDT", interval: "1" });
  db.close();
  cleanup(dbPath);

  assert.equal(result.price, null);
});

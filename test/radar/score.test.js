const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreByTicker, WINDOWS_MS } = require("../../telegram-radar/lib/score");

test("scoreByTicker: menção agora mesmo tem decaimento próximo de 1 em todas as janelas", () => {
  const now = Date.now();
  const scores = scoreByTicker([{ ticker: "BTC", time: now }], now);
  assert.ok(scores.BTC["1h"] > 0.99);
  assert.ok(scores.BTC["24h"] > 0.99);
  assert.ok(scores.BTC["7d"] > 0.99);
});

test("scoreByTicker: menção na borda da janela de 1h decai perto de zero, mas ainda conta em 24h", () => {
  const now = Date.now();
  const scores = scoreByTicker([{ ticker: "BTC", time: now - WINDOWS_MS["1h"] + 1000 }], now);
  assert.ok(scores.BTC["1h"] < 0.01);
  assert.ok(scores.BTC["24h"] > 0.9);
});

test("scoreByTicker: menção fora de todas as janelas não conta em nenhuma", () => {
  const now = Date.now();
  const scores = scoreByTicker([{ ticker: "BTC", time: now - WINDOWS_MS["7d"] - 1000 }], now);
  assert.equal(scores.BTC, undefined);
});

test("scoreByTicker: acumula múltiplas menções do mesmo ticker", () => {
  const now = Date.now();
  const scores = scoreByTicker(
    [
      { ticker: "SOL", time: now },
      { ticker: "SOL", time: now - 1000 },
    ],
    now
  );
  assert.ok(scores.SOL["1h"] > 1.9);
});

test("scoreByTicker: menções sem ticker são ignoradas", () => {
  const now = Date.now();
  const scores = scoreByTicker([{ ticker: null, time: now }], now);
  assert.deepEqual(scores, {});
});

test("scoreByTicker: tickers diferentes não se misturam", () => {
  const now = Date.now();
  const scores = scoreByTicker(
    [
      { ticker: "BTC", time: now },
      { ticker: "ETH", time: now },
    ],
    now
  );
  assert.ok(scores.BTC["1h"] > 0);
  assert.ok(scores.ETH["1h"] > 0);
});

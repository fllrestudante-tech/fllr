const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeLiquidity } = require("../lib/brains/liquidityBrain");

function candle(t, open, high, low, close, volume) {
  return [t, open, high, low, close, volume];
}
function flatCandle(t, price) {
  return candle(t, price, price, price, price, 100);
}
function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}

test("analyzeLiquidity: dado insuficiente -- NEUTRAL/0/0, forma completa mesmo vazia", () => {
  const result = analyzeLiquidity({ candles: [], lookback: 2, equalTolerancePct: 0.1, sweepReversalLookahead: 10 });
  assert.equal(result.state, "NEUTRAL");
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["dado histórico insuficiente"]);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.zones, { above: [], below: [] });
  assert.deepEqual(result.sweeps, []);
  assert.equal(result.imbalances, null);
  assert.equal(result.trappedTraders, null);
  assert.deepEqual(result.metadata.dependsOn, ["candles"]);
});

// Fixture verificado rodando o código real (script descartável) antes de
// fixar os asserts: padding flat (não gera swing nenhum) + 2 picos quase
// iguais (30, 30.2 -- dentro da tolerância) + candle de sweep bem no
// final da série (pavio 31 rompe, close 29 fecha de volta).
function sweepAtEndFixture() {
  const prices = [...ramp(50, 50, 170), ...ramp(10, 30, 10), ...ramp(28, 15, 10), ...ramp(16, 30.2, 10), ...ramp(28, 20, 5)];
  const candles = prices.map((p, i) => flatCandle(i * 60000, p));
  candles.push(candle(candles.length * 60000, 29, 31, 28.5, 29, 100));
  return candles;
}

test("analyzeLiquidity: sweep recente domina o state (SWEPT_HIGH), mesmo com zonas equilibradas", () => {
  const result = analyzeLiquidity({ candles: sweepAtEndFixture(), lookback: 2, equalTolerancePct: 0.5, sweepReversalLookahead: 10 });

  assert.equal(result.state, "SWEPT_HIGH");
  assert.ok(result.confidence > 0 && result.confidence <= 100);
  assert.ok(result.score > 0 && result.score <= 100);
  assert.ok(result.reasons[0].includes("Sweep de alta detectado"));

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].type, "SWEEP_HIGH");
  assert.equal(typeof result.evidence[0].confidence, "number");
  assert.equal(typeof result.evidence[0].weight, "number");
  assert.equal(typeof result.evidence[0].timestamp, "string");
  assert.equal(result.evidence[0].payload.level, 30.2);

  assert.equal(result.sweeps.length, 1);
  assert.equal(result.sweeps[0].reversalConfirmed, null); // sweep no último candle -- ainda não deu tempo de julgar, não fabricado

  assert.deepEqual(result.trappedTraders, {
    side: "longs", // sweep de alta prende quem comprou o rompimento falso
    confirmed: null,
    note: "proxy de preço, não confirmado por OI/volume real",
  });

  assert.equal(result.imbalances, null);
  assert.deepEqual(result.missingEvidence, [
    "Fair Value Gap (FVG)",
    "Order Blocks",
    "Stop Clusters (requer order book/Level 2, não coletado)",
    "Trapped Traders confirmado por OI (requer Context Fusion)",
  ]);
  assert.deepEqual(result.metadata.dependsOn, ["candles"]);
});

test("analyzeLiquidity: sem sweep e sem swings suficientes pra zona -- BALANCED", () => {
  // Série de 220 candles totalmente flat -- sem swing nenhum (nenhum ponto é extremo, todos empatados).
  const candles = new Array(220).fill(0).map((_, i) => flatCandle(i * 60000, 100));
  const result = analyzeLiquidity({ candles, lookback: 2, equalTolerancePct: 0.1, sweepReversalLookahead: 10 });

  assert.equal(result.state, "BALANCED");
  assert.equal(result.score, 0);
  assert.deepEqual(result.sweeps, []);
  assert.deepEqual(result.zones, { above: [], below: [] });
});

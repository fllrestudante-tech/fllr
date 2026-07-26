const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeStructure, computeScore, computeConfidence, classifyState, computePersistence } = require("../lib/brains/structureBrain");

function candle(t, price) {
  return [t, price, price, price, price, 100];
}
function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}
function flatCandles(n) {
  return new Array(n).fill([0, 1, 1, 1, 1, 1]);
}

// --- classifyState ---

test("classifyState: sem bias -> NEUTRAL mesmo com score alto (não fabrica leitura sem estrutura)", () => {
  assert.equal(classifyState({ bias: null, chochCountRecent: 0, lastEvent: { type: "BOS" }, score: 90 }), "NEUTRAL");
});

test("classifyState: >=2 CHOCH nos últimos eventos -> BROKEN", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 2, lastEvent: { type: "CHOCH" }, score: 10 }), "BROKEN");
});

test("classifyState: CHOCH isolado (só 1) -> WEAK", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 1, lastEvent: { type: "CHOCH" }, score: 50 }), "WEAK");
});

test("classifyState: BOS com score >=70 -> EXCELLENT", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 0, lastEvent: { type: "BOS" }, score: 75 }), "EXCELLENT");
});

test("classifyState: BOS com score entre 40-69 -> GOOD", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 0, lastEvent: { type: "BOS" }, score: 50 }), "GOOD");
});

test("classifyState: BOS com score <40 -> NEUTRAL", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 0, lastEvent: { type: "BOS" }, score: 20 }), "NEUTRAL");
});

test("classifyState: bias existe mas nenhum evento ainda -> NEUTRAL", () => {
  assert.equal(classifyState({ bias: "bullish", chochCountRecent: 0, lastEvent: null, score: 0 }), "NEUTRAL");
});

// --- computeScore ---

test("computeScore: sem lastEvent -> 0", () => {
  assert.equal(computeScore({ lastEvent: null, bias: null, swingHighs: [], swingLows: [], candles: [] }), 0);
});

test("computeScore: BOS -- soma o streak de HH+HL (bias bullish), escalado x12", () => {
  const swingHighs = [{ label: "HH" }, { label: "HH" }];
  const swingLows = [{ label: "HL" }];
  const score = computeScore({ lastEvent: { type: "BOS" }, bias: "bullish", swingHighs, swingLows, candles: [] });
  assert.equal(score, 3 * 12); // streak 2(HH)+1(HL)=3
});

test("computeScore: CHOCH -- magnitude % do rompimento, não o streak", () => {
  const candles = [[0, 100, 100, 100, 102, 1]]; // close=102, magnitude 2%
  const lastEvent = { type: "CHOCH", index: 0, level: 100 };
  const score = computeScore({ lastEvent, bias: "bullish", swingHighs: [], swingLows: [], candles });
  assert.equal(score, 2 * 20); // magnitude 2% * escala 20 = 40, bem abaixo do teto de 100
});

test("computeScore: nunca passa de 100 mesmo com streak/magnitude enormes", () => {
  const swingHighs = new Array(20).fill({ label: "HH" });
  const swingLows = new Array(20).fill({ label: "HL" });
  const score = computeScore({ lastEvent: { type: "BOS" }, bias: "bullish", swingHighs, swingLows, candles: [] });
  assert.equal(score, 100);
});

// --- computeConfidence ---

test("computeConfidence: combina os 4 pilares 30/30/20/20", () => {
  const candles = flatCandles(200); // dataQuality = 100
  const swingHighs = [{ label: "HH" }, { label: "HH" }]; // 2
  const swingLows = [{ label: "HL" }]; // 1 -> evidenceQty = min(100,3*5)=15
  const recentEvents = [{ type: "BOS" }, { type: "BOS" }]; // 100% BOS -> consistency=100
  const confidence = computeConfidence({ candles, swingHighs, swingLows, bias: "bullish", recentEvents, chochCountRecent: 0 });
  // 100*.3 + 15*.3 + 100*.2 + 100*.2 (highStreak=2>0 e lowStreak=1>0 -> consenso 100) = 30+4.5+20+20=74.5 -> 75
  assert.equal(confidence, 75);
});

test("computeConfidence: sem eventos ainda -- consistência default 100 (vacuosamente verdadeiro, não fabricado como 0)", () => {
  const candles = flatCandles(200);
  const confidence = computeConfidence({ candles, swingHighs: [], swingLows: [], bias: null, recentEvents: [], chochCountRecent: 0 });
  assert.equal(confidence, 30 + 0 + 20 + 0);
});

test("computeConfidence: dado insuficiente (menos candles que o mínimo) reduz o pilar de qualidade proporcionalmente", () => {
  const candles = flatCandles(100); // metade do mínimo (200) -> dataQuality=50
  const confidence = computeConfidence({ candles, swingHighs: [], swingLows: [], bias: null, recentEvents: [], chochCountRecent: 0 });
  assert.equal(confidence, 50 * 0.3 + 0 + 20 + 0);
});

// --- computePersistence ---

test("computePersistence: usa o último CHOCH como início da tendência atual", () => {
  const candles = flatCandles(10);
  const events = [
    { type: "BOS", index: 2 },
    { type: "CHOCH", index: 5 },
    { type: "BOS", index: 8 },
  ];
  assert.equal(computePersistence({ candles, events, swingHighs: [], swingLows: [] }), 9 - 5);
});

test("computePersistence: sem CHOCH nunca -- usa o primeiro swing confirmado", () => {
  const candles = flatCandles(10);
  const swingHighs = [{ index: 3 }];
  const swingLows = [{ index: 5 }];
  assert.equal(computePersistence({ candles, events: [], swingHighs, swingLows }), 9 - 3);
});

test("computePersistence: sem swings nem CHOCH -- 0", () => {
  const candles = flatCandles(10);
  assert.equal(computePersistence({ candles, events: [], swingHighs: [], swingLows: [] }), 0);
});

// --- analyzeStructure (integração) ---

test("analyzeStructure: dado insuficiente -- NEUTRAL/0/0, forma completa mesmo vazia", () => {
  const result = analyzeStructure({ candles: [], lookback: 2 });
  assert.equal(result.state, "NEUTRAL");
  assert.equal(result.confidence, 0);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ["dado histórico insuficiente"]);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.trend.bias, null);
  assert.equal(result.trend.quality, "NEUTRAL");
  assert.equal(result.liquidity.state, null);
  assert.equal(result.supportResistance.nearestSupport, null);
  assert.deepEqual(result.metadata.dependsOn, ["candles"]);
});

// Mesmo fixture verificado (rodando o código real) em test/structureEvidence.test.js
// -- BOS bullish + 2 CHOCH bearish -- estendido com padding flat pra passar
// dos 200 candles mínimos exigidos pelo Structure Brain.
function longBosChochCandles() {
  const prices = [
    ...ramp(10, 19, 10),
    ...ramp(18, 9, 10),
    ...ramp(10, 29, 10),
    ...ramp(28, 14, 10),
    ...ramp(15, 60, 15),
    ...ramp(58, 2, 20),
    ...ramp(2, 2, 130),
  ];
  return prices.map((p, i) => candle(i * 60000, p));
}

test("analyzeStructure: com dado real suficiente, devolve a forma completa do BrainResult", () => {
  const result = analyzeStructure({ candles: longBosChochCandles(), lookback: 2 });

  assert.ok(["EXCELLENT", "GOOD", "NEUTRAL", "WEAK", "BROKEN"].includes(result.state));
  assert.ok(result.confidence >= 0 && result.confidence <= 100);
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.reasons.length > 0);

  assert.ok(result.evidence.length > 0);
  for (const e of result.evidence) {
    assert.ok(["BOS", "CHOCH"].includes(e.type));
    assert.equal(typeof e.confidence, "number");
    assert.equal(typeof e.weight, "number");
    assert.equal(typeof e.timestamp, "string");
    assert.equal(typeof e.payload.level, "number");
  }

  assert.deepEqual(result.missingEvidence, [
    "Equal Highs/Lows",
    "Liquidity Sweep",
    "Fair Value Gap (FVG)",
    "Order Blocks",
    "Breaker Blocks",
    "Mitigation Blocks",
  ]);
  assert.equal(result.liquidity.state, null);
  assert.equal(result.supportResistance.nearestSupport, null);
  assert.equal(result.trend.quality, result.state);
  assert.deepEqual(result.metadata.dependsOn, ["candles"]);
  assert.ok(result.swings.highs.length > 0);
  assert.ok(result.swings.lows.length > 0);
});

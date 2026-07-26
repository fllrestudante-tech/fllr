const test = require("node:test");
const assert = require("node:assert/strict");
const { detectSwingHighs, detectSwingLows, classifySwingHighs, classifySwingLows, computeTrailingStreak } = require("../lib/marketStructure/swingDetector");

function candle(t, price) {
  return [t, price, price, price, price, 100];
}
function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}

// Zigzag verificado rodando o código real (script descartável) antes de
// fixar os testes -- 4 pernas: sobe (pico idx9), desce (vale idx19), sobe
// mais alto (pico idx29, HH), desce menos (vale idx39, HL) -- + um pequeno
// padding no final só pra dar espaço (lookback candles à frente) pro
// último swing (idx39) ser confirmado; sem isso ele fica sempre
// "pendente" por estar perto demais da borda da série.
function zigzagCandles() {
  const prices = [...ramp(10, 19, 10), ...ramp(18, 9, 10), ...ramp(10, 29, 10), ...ramp(28, 14, 10), ...ramp(16, 20, 5)];
  return prices.map((p, i) => candle(i * 60000, p));
}

test("detectSwingHighs: acha os picos certos nos índices certos, com lookback=2", () => {
  const highs = detectSwingHighs(zigzagCandles(), 2);
  assert.deepEqual(
    highs.map((h) => h.index),
    [9, 29]
  );
  assert.equal(highs[0].price, 19);
  assert.equal(highs[1].price, 29);
});

test("detectSwingLows: acha os vales certos nos índices certos, com lookback=2", () => {
  const lows = detectSwingLows(zigzagCandles(), 2);
  assert.deepEqual(
    lows.map((l) => l.index),
    [19, 39]
  );
  assert.equal(lows[0].price, 9);
  assert.equal(lows[1].price, 14);
});

test("classifySwingHighs: primeiro fica label null, segundo HH (preço maior)", () => {
  const highs = classifySwingHighs(detectSwingHighs(zigzagCandles(), 2));
  assert.equal(highs[0].label, null);
  assert.equal(highs[1].label, "HH");
});

test("classifySwingHighs: LH quando o novo pico é menor que o anterior", () => {
  const swings = [{ price: 30 }, { price: 20 }];
  const classified = classifySwingHighs(swings);
  assert.equal(classified[0].label, null);
  assert.equal(classified[1].label, "LH");
});

test("classifySwingLows: primeiro fica label null, segundo HL (vale maior)", () => {
  const lows = classifySwingLows(detectSwingLows(zigzagCandles(), 2));
  assert.equal(lows[0].label, null);
  assert.equal(lows[1].label, "HL");
});

test("classifySwingLows: LL quando o novo vale é menor que o anterior", () => {
  const swings = [{ price: 20 }, { price: 10 }];
  const classified = classifySwingLows(swings);
  assert.equal(classified[0].label, null);
  assert.equal(classified[1].label, "LL");
});

test("computeTrailingStreak: conta os labels iguais contando do fim pra trás", () => {
  const swings = [{ label: "LH" }, { label: "HH" }, { label: "HH" }, { label: "HH" }];
  assert.equal(computeTrailingStreak(swings, "HH"), 3);
  assert.equal(computeTrailingStreak(swings, "LH"), 0); // não é o último, streak do fim é 0
});

test("computeTrailingStreak: para no primeiro null (nunca conta o primeiro swing de um tipo)", () => {
  const swings = [{ label: null }, { label: "HH" }];
  assert.equal(computeTrailingStreak(swings, "HH"), 1);
});

test("computeTrailingStreak: array vazio -- 0, não quebra", () => {
  assert.equal(computeTrailingStreak([], "HH"), 0);
});

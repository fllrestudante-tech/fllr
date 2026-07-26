const test = require("node:test");
const assert = require("node:assert/strict");
const { extractStructureEvidence, computeBias } = require("../lib/marketStructure/structureEvidence");

function candle(t, price) {
  return [t, price, price, price, price, 100];
}
function ramp(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
  return out;
}

test("computeBias: HH+HL = bullish, LH+LL = bearish, misto = null", () => {
  assert.equal(computeBias("HH", "HL"), "bullish");
  assert.equal(computeBias("LH", "LL"), "bearish");
  assert.equal(computeBias("HH", "LL"), null);
  assert.equal(computeBias(null, "HL"), null);
});

// Fixture verificado rodando o código real antes de fixar os asserts (não
// calculado só de cabeça -- lição da sessão: fórmulas de estrutura são
// fáceis de errar por engano de índice/timing). 6 pernas: sobe (pico
// idx9) / desce (vale idx19) / sobe mais alto (pico idx29, HH) / desce
// menos (vale idx39, HL -- bias vira bullish aqui) / sobe forte rompendo
// o pico anterior (BOS bullish esperado) / despenca rompendo o vale HL e
// depois o vale mais antigo (2 CHOCH bearish esperados).
function bosChochCandles() {
  const prices = [
    ...ramp(10, 19, 10),
    ...ramp(18, 9, 10),
    ...ramp(10, 29, 10),
    ...ramp(28, 14, 10),
    ...ramp(15, 60, 15),
    ...ramp(58, 2, 20),
  ];
  return prices.map((p, i) => candle(i * 60000, p));
}

test("extractStructureEvidence: bias vira bullish depois de HH+HL confirmados", () => {
  const result = extractStructureEvidence(bosChochCandles(), { lookback: 2 });
  assert.equal(result.bias, "bullish");
});

test("extractStructureEvidence: BOS bullish ao romper o HH em continuação de tendência", () => {
  const result = extractStructureEvidence(bosChochCandles(), { lookback: 2 });
  const bos = result.events.find((e) => e.type === "BOS");
  assert.ok(bos, "deveria haver pelo menos 1 evento BOS");
  assert.equal(bos.direction, "bullish");
  assert.equal(bos.level, 29);
  assert.equal(bos.brokenSwing.label, "HH");
});

test("extractStructureEvidence: CHOCH bearish ao romper a HL vigente (contra o bias bullish)", () => {
  const result = extractStructureEvidence(bosChochCandles(), { lookback: 2 });
  const chochs = result.events.filter((e) => e.type === "CHOCH");
  assert.ok(chochs.length >= 1, "deveria haver pelo menos 1 evento CHOCH");
  assert.equal(chochs[0].direction, "bearish");
  assert.equal(chochs[0].level, 14);
  assert.equal(chochs[0].brokenSwing.label, "HL");
});

test("extractStructureEvidence: eventos vêm em ordem cronológica (index crescente)", () => {
  const result = extractStructureEvidence(bosChochCandles(), { lookback: 2 });
  for (let i = 1; i < result.events.length; i++) {
    assert.ok(result.events[i].index >= result.events[i - 1].index);
  }
});

test("extractStructureEvidence: sem bias estabelecido, nenhum evento é emitido (nunca fabrica BOS/CHOCH sem referência)", () => {
  // Série curta demais pra formar o 2º swing de cada tipo -- bias nunca sai de null.
  const prices = [...ramp(10, 19, 10), ...ramp(18, 9, 10)];
  const candles = prices.map((p, i) => candle(i * 60000, p));
  const result = extractStructureEvidence(candles, { lookback: 2 });
  assert.equal(result.bias, null);
  assert.equal(result.events.length, 0);
});

test("extractStructureEvidence: série vazia -- não quebra", () => {
  const result = extractStructureEvidence([], { lookback: 2 });
  assert.equal(result.bias, null);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.swingHighs, []);
  assert.deepEqual(result.swingLows, []);
});

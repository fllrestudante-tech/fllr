const test = require("node:test");
const assert = require("node:assert/strict");
const { classify } = require("../../telegram-radar/lib/classify");

test("classify: termos bullish predominantes classificam como bullish", () => {
  const r = classify("Rompimento confirmado, buy zone agora, vai pra lua!");
  assert.equal(r.sentiment, "bullish");
  assert.ok(r.confidence > 0);
});

test("classify: termos bearish predominantes classificam como bearish", () => {
  const r = classify("Queda forte, hora de short, distribuicao clara");
  assert.equal(r.sentiment, "bearish");
  assert.ok(r.confidence > 0);
});

test("classify: sem termos reconhecidos é neutral com confiança zero", () => {
  const r = classify("Bom dia pessoal, como estão?");
  assert.equal(r.sentiment, "neutral");
  assert.equal(r.confidence, 0);
  assert.deepEqual(r.matchedKeywords, []);
});

test("classify: empate entre bullish e bearish é neutral", () => {
  const r = classify("pump e ao mesmo tempo dump, sinal confuso");
  assert.equal(r.sentiment, "neutral");
});

test("classify: confiança cresce com mais termos batidos, capada em 1", () => {
  const um = classify("pump");
  const tres = classify("pump breakout moon");
  assert.ok(tres.confidence > um.confidence);
  assert.ok(tres.confidence <= 1);
});

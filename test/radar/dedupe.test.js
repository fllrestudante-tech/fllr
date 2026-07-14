const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeText, hashText, isDuplicate } = require("../../telegram-radar/lib/dedupe");

test("normalizeText: ignora maiúsculas, pontuação, acentos e espaços extras", () => {
  assert.equal(normalizeText("Rompimento à VISTA,   ação forte!!!"), "rompimento a vista acao forte");
});

test("hashText: mesmo texto normalizado gera o mesmo hash mesmo com formatação diferente", () => {
  const a = hashText("BTC vai romper agora!! 🚀");
  const b = hashText("btc vai romper agora");
  assert.equal(a, b);
});

test("hashText: textos com conteúdo diferente geram hashes diferentes", () => {
  assert.notEqual(hashText("BTC vai subir"), hashText("ETH vai cair"));
});

test("isDuplicate: mesmo texto dentro da janela é duplicata", () => {
  const now = Date.now();
  const recentHashes = [{ hash: hashText("call repostada"), time: now - 60000 }];
  assert.equal(isDuplicate("call repostada", recentHashes, 10 * 60 * 1000, now), true);
});

test("isDuplicate: mesmo texto fora da janela não é duplicata", () => {
  const now = Date.now();
  const recentHashes = [{ hash: hashText("call antiga"), time: now - 20 * 60 * 1000 }];
  assert.equal(isDuplicate("call antiga", recentHashes, 10 * 60 * 1000, now), false);
});

test("isDuplicate: texto diferente não é duplicata mesmo dentro da janela", () => {
  const now = Date.now();
  const recentHashes = [{ hash: hashText("call A"), time: now - 60000 }];
  assert.equal(isDuplicate("call B", recentHashes, 10 * 60 * 1000, now), false);
});

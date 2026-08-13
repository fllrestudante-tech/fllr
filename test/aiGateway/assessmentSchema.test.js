const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAssessment } = require("../../lib/aiGateway/assessmentSchema");

const FULL_PAYLOAD = {
  bias: "bullish",
  strength: 72,
  confidence: 80,
  marketRegime: "TRENDING_BULL",
  signalQuality: "HIGH",
  riskLevel: "LOW",
  recommendation: "FAVOR_ENTRY",
  rationale: "tendência forte",
  riskFlags: ["volatilidade alta"],
};

test("parseAssessment: JSON válido e completo (todos os campos novos) é aceito sem parseError", () => {
  const r = parseAssessment(JSON.stringify(FULL_PAYLOAD));
  assert.equal(r.bias, "bullish");
  assert.equal(r.strength, 72);
  assert.equal(r.confidence, 80);
  assert.equal(r.marketRegime, "TRENDING_BULL");
  assert.equal(r.signalQuality, "HIGH");
  assert.equal(r.riskLevel, "LOW");
  assert.equal(r.recommendation, "FAVOR_ENTRY");
  assert.equal(r.rationale, "tendência forte");
  assert.deepEqual(r.riskFlags, ["volatilidade alta"]);
  assert.equal(r.parseError, null);
});

test("parseAssessment: payload sem os campos novos (schema antigo) cai em partial_schema, mas não lança e preenche defaults seguros", () => {
  const r = parseAssessment(JSON.stringify({ bias: "bullish", strength: 72, rationale: "x", riskFlags: [] }));
  assert.equal(r.bias, "bullish"); // campo presente e válido continua respeitado
  assert.equal(r.confidence, 0);
  assert.equal(r.marketRegime, "UNCLEAR");
  assert.equal(r.signalQuality, "LOW");
  assert.equal(r.riskLevel, "MEDIUM"); // default seguro, não LOW -- nunca parece "mercado calmo" por omissão
  assert.equal(r.recommendation, "NO_OPINION");
  assert.equal(r.parseError, "partial_schema");
});

test("parseAssessment: marketRegime/signalQuality/riskLevel/recommendation fora do enum caem pro default seguro com partial_schema", () => {
  const r = parseAssessment(
    JSON.stringify({ ...FULL_PAYLOAD, marketRegime: "LUA_CHEIA", signalQuality: "ULTRA", riskLevel: "CALMO", recommendation: "COMPRE_TUDO" })
  );
  assert.equal(r.marketRegime, "UNCLEAR");
  assert.equal(r.signalQuality, "LOW");
  assert.equal(r.riskLevel, "MEDIUM");
  assert.equal(r.recommendation, "NO_OPINION");
  assert.equal(r.parseError, "partial_schema");
});

test("parseAssessment: confidence fora de 0-100 é clampado, igual strength", () => {
  assert.equal(parseAssessment(JSON.stringify({ ...FULL_PAYLOAD, confidence: 150 })).confidence, 100);
  assert.equal(parseAssessment(JSON.stringify({ ...FULL_PAYLOAD, confidence: -20 })).confidence, 0);
});

test("parseAssessment: texto vazio/nulo vira neutro com parseError empty_response", () => {
  assert.equal(parseAssessment("").parseError, "empty_response");
  assert.equal(parseAssessment("   ").parseError, "empty_response");
  assert.equal(parseAssessment(null).parseError, "empty_response");
  assert.equal(parseAssessment(undefined).bias, "neutral");
});

test("parseAssessment: JSON inválido não lança, vira neutro com parseError invalid_json", () => {
  const r = parseAssessment("isso não é JSON {");
  assert.equal(r.bias, "neutral");
  assert.equal(r.strength, 0);
  assert.equal(r.parseError, "invalid_json");
});

test("parseAssessment: bias fora do enum cai pra neutral com parseError partial_schema", () => {
  const r = parseAssessment(JSON.stringify({ bias: "muito_bullish", strength: 50 }));
  assert.equal(r.bias, "neutral");
  assert.equal(r.parseError, "partial_schema");
});

test("parseAssessment: strength fora de 0-100 é clampado", () => {
  assert.equal(parseAssessment(JSON.stringify({ bias: "bullish", strength: 150 })).strength, 100);
  assert.equal(parseAssessment(JSON.stringify({ bias: "bearish", strength: -20 })).strength, 0);
});

test("parseAssessment: strength ausente/não numérico vira 0 e marca partial_schema", () => {
  const r = parseAssessment(JSON.stringify({ bias: "bullish" }));
  assert.equal(r.strength, 0);
  assert.equal(r.parseError, "partial_schema");
});

test("parseAssessment: riskFlags não-array ou com itens não-string é filtrado/ignorado", () => {
  assert.deepEqual(parseAssessment(JSON.stringify({ bias: "neutral", strength: 10, riskFlags: "não é array" })).riskFlags, []);
  const r = parseAssessment(JSON.stringify({ bias: "neutral", strength: 10, riskFlags: ["ok", 42, null] }));
  assert.deepEqual(r.riskFlags, ["ok"]);
});

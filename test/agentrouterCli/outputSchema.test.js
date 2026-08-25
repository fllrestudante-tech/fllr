const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { getAgentRouterAssessmentSchema, SCHEMA_VERSION } = require("../../lib/agentrouterCli/outputSchema");
const {
  parseAssessment,
  VALID_BIAS,
  VALID_MARKET_REGIME,
  VALID_SIGNAL_QUALITY,
  VALID_RISK_LEVEL,
  VALID_RECOMMENDATION,
} = require("../../lib/aiGateway/assessmentSchema");

const REQUIRED_FIELDS = [
  "bias",
  "strength",
  "confidence",
  "marketRegime",
  "signalQuality",
  "riskLevel",
  "recommendation",
  "rationale",
  "riskFlags",
];

test("estrutura básica: object, additionalProperties false, required completo", () => {
  const schema = getAgentRouterAssessmentSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_FIELDS].sort());
  assert.deepEqual(Object.keys(schema.properties).sort(), [...REQUIRED_FIELDS].sort());
});

test("enums batem byte-a-byte com assessmentSchema.js -- fonte única de verdade", () => {
  const schema = getAgentRouterAssessmentSchema();
  assert.deepEqual(schema.properties.bias.enum, Array.from(VALID_BIAS));
  assert.deepEqual(schema.properties.marketRegime.enum, Array.from(VALID_MARKET_REGIME));
  assert.deepEqual(schema.properties.signalQuality.enum, Array.from(VALID_SIGNAL_QUALITY));
  assert.deepEqual(schema.properties.riskLevel.enum, Array.from(VALID_RISK_LEVEL));
  assert.deepEqual(schema.properties.recommendation.enum, Array.from(VALID_RECOMMENDATION));
});

test("strength/confidence: integer 0-100", () => {
  const schema = getAgentRouterAssessmentSchema();
  for (const field of ["strength", "confidence"]) {
    const prop = schema.properties[field];
    assert.equal(prop.type, "integer");
    assert.equal(prop.minimum, 0);
    assert.equal(prop.maximum, 100);
  }
});

test("rationale: string com maxLength; riskFlags: array de strings com maxItems/maxLength", () => {
  const schema = getAgentRouterAssessmentSchema();
  assert.equal(schema.properties.rationale.type, "string");
  assert.equal(schema.properties.rationale.maxLength, 2000);
  assert.equal(schema.properties.riskFlags.type, "array");
  assert.equal(schema.properties.riskFlags.maxItems, 20);
  assert.equal(schema.properties.riskFlags.items.type, "string");
  assert.equal(schema.properties.riskFlags.items.maxLength, 256);
});

test("getAgentRouterAssessmentSchema() sempre devolve cópia nova -- mutar uma chamada não afeta a próxima", () => {
  const first = getAgentRouterAssessmentSchema();
  first.properties.bias.enum.push("adulterado");
  first.title = "mutado";

  const second = getAgentRouterAssessmentSchema();
  assert.notEqual(second.properties.bias.enum.includes("adulterado"), true);
  assert.notEqual(second.title, "mutado");
});

test("nenhum texto em português no schema (sem acentuação/caracteres PT)", () => {
  const serialized = JSON.stringify(getAgentRouterAssessmentSchema());
  assert.equal(/[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(serialized), false);
});

test("compatibilidade real: um objeto que satisfaz o schema passa por parseAssessment sem parseError", () => {
  const sample = {
    bias: Array.from(VALID_BIAS)[0],
    strength: 50,
    confidence: 70,
    marketRegime: Array.from(VALID_MARKET_REGIME)[0],
    signalQuality: Array.from(VALID_SIGNAL_QUALITY)[0],
    riskLevel: Array.from(VALID_RISK_LEVEL)[0],
    recommendation: Array.from(VALID_RECOMMENDATION)[0],
    rationale: "Test rationale in English.",
    riskFlags: ["low_liquidity"],
  };
  const parsed = parseAssessment(JSON.stringify(sample));
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.bias, sample.bias);
  assert.equal(parsed.strength, sample.strength);
  assert.equal(parsed.confidence, sample.confidence);
  assert.equal(parsed.marketRegime, sample.marketRegime);
  assert.equal(parsed.signalQuality, sample.signalQuality);
  assert.equal(parsed.riskLevel, sample.riskLevel);
  assert.equal(parsed.recommendation, sample.recommendation);
  assert.equal(parsed.rationale, sample.rationale);
  assert.deepEqual(parsed.riskFlags, sample.riskFlags);
});

test("compatibilidade: campos do schema batem com o que parseAssessment devolve (exceto parseError, que é derivado, não vem do model)", () => {
  const parsed = parseAssessment(
    JSON.stringify({
      bias: "neutral",
      strength: 0,
      confidence: 0,
      marketRegime: "UNCLEAR",
      signalQuality: "LOW",
      riskLevel: "MEDIUM",
      recommendation: "NO_OPINION",
      rationale: "",
      riskFlags: [],
    })
  );
  const fields = Object.keys(parsed).filter((k) => k !== "parseError");
  assert.deepEqual(fields.sort(), [...REQUIRED_FIELDS].sort());
});

// =====================================================================
// SCHEMA_VERSION (Fase 10 / Commit 4a) -- so' o export e' novo; o schema
// em si precisa continuar identico. Travado por hash do JSON serializado.
// =====================================================================

test("SCHEMA_VERSION esta exportado e vale 'v1'", () => {
  assert.equal(SCHEMA_VERSION, "v1");
});

test("getAgentRouterAssessmentSchema() continua produzindo exatamente o mesmo JSON (hash travado) -- Commit 4a nao alterou o schema", () => {
  const digest = crypto.createHash("sha256").update(JSON.stringify(getAgentRouterAssessmentSchema()), "utf8").digest("hex");
  assert.equal(digest, "6c29a6748cda8484797fbaa4bd9a5ef5a08a33d395b4d47068241bc13946b82b");
});

// Contrato --output-schema do Codex CLI para o assessment do AgentRouter --
// puro, sem I/O, sem criar arquivo (a materialização em disco fica
// exclusivamente em lib/agentrouterClient.js, que sabe qual pasta temporária
// usar). Os enums vêm de lib/aiGateway/assessmentSchema.js -- fonte única de
// verdade -- nunca duplicados aqui manualmente, pra nunca divergir do que
// parseAssessment() de fato aceita depois.
const {
  VALID_BIAS,
  VALID_MARKET_REGIME,
  VALID_SIGNAL_QUALITY,
  VALID_RISK_LEVEL,
  VALID_RECOMMENDATION,
} = require("../aiGateway/assessmentSchema");

const AGENTROUTER_ASSESSMENT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Crypto10AgentRouterAssessment",
  type: "object",
  additionalProperties: false,
  required: [
    "bias",
    "strength",
    "confidence",
    "marketRegime",
    "signalQuality",
    "riskLevel",
    "recommendation",
    "rationale",
    "riskFlags",
  ],
  properties: {
    bias: {
      type: "string",
      enum: Array.from(VALID_BIAS),
      description: "Directional read of the market context provided.",
    },
    strength: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Signal strength, 0-100.",
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description: "Model's own confidence in this reading, 0-100.",
    },
    marketRegime: {
      type: "string",
      enum: Array.from(VALID_MARKET_REGIME),
      description: "Current market regime classification.",
    },
    signalQuality: {
      type: "string",
      enum: Array.from(VALID_SIGNAL_QUALITY),
      description: "Quality of the underlying quant signal.",
    },
    riskLevel: {
      type: "string",
      enum: Array.from(VALID_RISK_LEVEL),
      description: "Assessed risk level for this context.",
    },
    recommendation: {
      type: "string",
      enum: Array.from(VALID_RECOMMENDATION),
      description: "Advisory label only -- never an order. Final decisions belong exclusively to the deterministic risk/execution engine, outside this model's control.",
    },
    rationale: {
      type: "string",
      maxLength: 2000,
      description: "1-3 sentences, English, for human audit only. No decision logic reads this field.",
    },
    riskFlags: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 256 },
      description: "Short risk flag strings, if any.",
    },
  },
};

/**
 * Única forma exportada de obter o schema: sempre uma cópia nova
 * (structuredClone). O objeto module-level acima nunca é exportado
 * diretamente -- ninguém de fora consegue mutar a fonte compartilhada por
 * engano (ex: `schema.properties.bias.enum.push(...)` num teste ou no
 * client acidentalmente vazando pra próxima chamada).
 */
function getAgentRouterAssessmentSchema() {
  return structuredClone(AGENTROUTER_ASSESSMENT_SCHEMA);
}

module.exports = { getAgentRouterAssessmentSchema };

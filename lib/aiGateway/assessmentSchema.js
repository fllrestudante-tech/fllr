// Valida/normaliza a resposta em texto de um provider de IA. Nunca lança --
// uma resposta malformada ou vazia degrada pra um assessment neutro/seguro
// com parseError preenchido, em vez de derrubar o Gateway. `rationale` é
// mantido só pra auditoria/leitura humana -- nenhum código de decisão faz
// parsing ou branch em cima desse texto livre (regra explícita do usuário,
// 2026-08-11): toda informação que importa pra decisão vem dos campos
// estruturados/enum abaixo.
// Versao ESTATICA do schema efetivo deste arquivo -- fonte unica pra
// lib/aiGateway/agentRouterAssessmentKey.js::computeAssessmentKey()
// (campo obrigatorio `schemaVersion`, Commit 4c2). NUNCA derivada
// dinamicamente do conteudo do arquivo (ex.: hash do source) -- e' um
// literal versionado manualmente, igual PROMPT_VERSION em
// promptBuilderEnglish.js: sobe so quando o schema EFETIVO (os Sets/
// clampInt/parseAssessment abaixo) muda de verdade. Formato compativel
// com SHORT_TOKEN_PATTERN de agentRouterAssessmentKey.js.
const SCHEMA_VERSION = "v1";

const VALID_BIAS = new Set(["bullish", "bearish", "neutral"]);
const VALID_MARKET_REGIME = new Set(["TRENDING_BULL", "TRENDING_BEAR", "RANGING", "VOLATILE", "UNCLEAR"]);
const VALID_SIGNAL_QUALITY = new Set(["HIGH", "MEDIUM", "LOW"]);
const VALID_RISK_LEVEL = new Set(["LOW", "MEDIUM", "HIGH", "EXTREME"]);
// Rótulos puramente consultivos -- nunca uma ordem. Quem decide/executa é
// sempre lib/risk.js + index.js (Quant/Risk/Execution), nunca a IA.
const VALID_RECOMMENDATION = new Set(["FAVOR_ENTRY", "AVOID_ENTRY", "FAVOR_EXIT", "HOLD_POSITION", "REDUCE_RISK", "NO_OPINION"]);

function clampInt(value, min, max) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : null;
}

function parseAssessment(text) {
  if (typeof text !== "string" || !text.trim()) {
    return {
      bias: "neutral",
      strength: 0,
      confidence: 0,
      marketRegime: "UNCLEAR",
      signalQuality: "LOW",
      riskLevel: "MEDIUM",
      recommendation: "NO_OPINION",
      rationale: "Resposta vazia da IA",
      riskFlags: [],
      parseError: "empty_response",
    };
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return {
      bias: "neutral",
      strength: 0,
      confidence: 0,
      marketRegime: "UNCLEAR",
      signalQuality: "LOW",
      riskLevel: "MEDIUM",
      recommendation: "NO_OPINION",
      rationale: "Resposta da IA não é JSON válido",
      riskFlags: [],
      parseError: "invalid_json",
    };
  }

  const bias = VALID_BIAS.has(obj.bias) ? obj.bias : "neutral";
  const strength = clampInt(obj.strength, 0, 100) ?? 0;
  const confidence = clampInt(obj.confidence, 0, 100) ?? 0;
  const marketRegime = VALID_MARKET_REGIME.has(obj.marketRegime) ? obj.marketRegime : "UNCLEAR";
  const signalQuality = VALID_SIGNAL_QUALITY.has(obj.signalQuality) ? obj.signalQuality : "LOW";
  // riskLevel cai em MEDIUM (não LOW) por padrão -- resposta ausente/malformada
  // nunca deve ser lida como "mercado calmo" por quem olhar o log depois.
  const riskLevel = VALID_RISK_LEVEL.has(obj.riskLevel) ? obj.riskLevel : "MEDIUM";
  const recommendation = VALID_RECOMMENDATION.has(obj.recommendation) ? obj.recommendation : "NO_OPINION";
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const riskFlags = Array.isArray(obj.riskFlags) ? obj.riskFlags.filter((f) => typeof f === "string") : [];

  const wellFormed =
    VALID_BIAS.has(obj.bias) &&
    Number.isFinite(obj.strength) &&
    Number.isFinite(obj.confidence) &&
    VALID_MARKET_REGIME.has(obj.marketRegime) &&
    VALID_SIGNAL_QUALITY.has(obj.signalQuality) &&
    VALID_RISK_LEVEL.has(obj.riskLevel) &&
    VALID_RECOMMENDATION.has(obj.recommendation);
  const parseError = wellFormed ? null : "partial_schema";

  return { bias, strength, confidence, marketRegime, signalQuality, riskLevel, recommendation, rationale, riskFlags, parseError };
}

module.exports = {
  parseAssessment,
  SCHEMA_VERSION,
  VALID_BIAS,
  VALID_MARKET_REGIME,
  VALID_SIGNAL_QUALITY,
  VALID_RISK_LEVEL,
  VALID_RECOMMENDATION,
};

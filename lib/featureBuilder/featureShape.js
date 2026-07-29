// Contrato comum de Feature -- mesmo espírito de
// lib/brains/brainResult.js::createBrainResult, uma função só embrulha o
// formato, nunca decide nada. `state` é sempre um dos 5 valores
// categóricos abaixo (nunca boolean -- daqui a meses vai precisar
// diferenciar HIGH de EXTREME sem quebrar quem já lê o campo).
// `strength` (força do sinal) e `confidence` (confiança no dado) são
// propositalmente separados, mesmo espírito de `score`/`confidence`
// distintos em brainResult.js.
const STATES = ["UNKNOWN", "LOW", "NORMAL", "HIGH", "EXTREME"];
const FEATURE_TYPES = ["EXTREME", "ACCELERATION", "EXPANSION", "COMPRESSION", "PERSISTENCE", "ANOMALY"];

// Versão do "gerador" de Features em si -- bump manual numa revisão
// grande do pipeline Knowledge->Statistics->Feature Builder inteiro,
// mesmo espírito do `knowledgeVersion` que lib/knowledgeBase/resolver.js
// já usa no seu envelope.
const KNOWLEDGE_VERSION = 1;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** 0-100, força do sinal -- hipótese v1 simples e uniforme pra todas as Features: escala pelo zscore (|zscore| ~4 satura em 100). Não validada, documentada como tal. */
function computeStrength(zscore) {
  if (typeof zscore !== "number" || !isFinite(zscore)) return 0;
  return clamp(Math.round(Math.abs(zscore) * 25), 0, 100);
}

function createFeature({ id, feature, featureType, version = 1, observation, state, direction = "neutral", confidence, source, resolverVersion, statisticsVersion }) {
  if (!STATES.includes(state)) {
    throw new Error(`state inválido "${state}" -- precisa ser um de: ${STATES.join(", ")}`);
  }
  if (!FEATURE_TYPES.includes(featureType)) {
    throw new Error(`featureType inválido "${featureType}" -- precisa ser um de: ${FEATURE_TYPES.join(", ")}`);
  }

  return {
    id,
    version,
    feature,
    featureType,
    observation,
    interpretation: { state, direction },
    strength: computeStrength(observation ? observation.zscore : null),
    confidence,
    metadata: {
      computedAt: new Date().toISOString(),
      source,
      resolverVersion,
      statisticsVersion,
      knowledgeVersion: KNOWLEDGE_VERSION,
    },
  };
}

function isFeatureActive(feature) {
  return feature.interpretation.state === "HIGH" || feature.interpretation.state === "EXTREME";
}

/**
 * Usado por todo builder quando `resolveMetricSignal` devolve `null`
 * (métrica ainda não computada nessa janela/símbolo) -- nunca lança
 * erro, devolve a Feature com `state: "UNKNOWN"` de forma honesta.
 */
function createUnknownFeature({ id, feature, featureType, version = 1 }) {
  return createFeature({
    id,
    feature,
    featureType,
    version,
    observation: {},
    state: "UNKNOWN",
    direction: "neutral",
    confidence: 0,
    source: "StatisticalResolver",
    resolverVersion: null,
    statisticsVersion: null,
  });
}

module.exports = { createFeature, createUnknownFeature, isFeatureActive, STATES, FEATURE_TYPES, KNOWLEDGE_VERSION };

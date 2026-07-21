// Narrative Engine v0 -- orquestrador determinístico (regex/regras) que
// transforma texto bruto (telegram_messages_raw.text) num sinal estruturado
// pronto pra gravar em telegram_signals. Cada extractXxx é um módulo
// independente: no futuro, qualquer um pode ser substituído por uma chamada
// de IA sem alterar os outros nem o formato de saída (ver README.md).
const { extractTicker } = require("./extractTicker");
const { extractDirection } = require("./extractDirection");
const { extractStructure } = require("./extractStructure");
const { extractTimeframe } = require("./extractTimeframe");
const { extractIndicators } = require("./extractIndicators");
const { extractSentiment } = require("./extractSentiment");
const { extractSignalType } = require("./extractSignalType");
const { extractMessageType } = require("./extractMessageType");
const { extractPriceMentioned } = require("./extractPriceMentioned");
const { detectLanguage } = require("./detectLanguage");
const { buildFeatureVector } = require("./featureVector");
const { computeConfidenceBreakdown } = require("./confidenceBreakdown");

const CLASSIFIER_NAME = "narrative_engine";
const CLASSIFIER_VERSION = "0";

// Tipos de mensagem que não carregam sinal de trading nenhum -- usados só
// pra marcar is_relevant, não pra descartar (telegram_signals guarda TODA
// mensagem classificada, relevante ou não -- é o próprio Source Reliability
// Engine que decide o que fazer com isso depois).
const NOT_RELEVANT_TYPES = new Set(["CHAT", "ADVERTISEMENT"]);
// hasLink é recalculado do texto (não confia em telegram_messages_raw.links)
// -- classify() recebe só texto de propósito, pra funcionar igual sobre
// qualquer fonte futura (YouTube/X), não só sobre linhas do Telegram.
const URL_REGEX = /https?:\/\//i;

function classify(text) {
  const safeText = text || "";
  const { ticker, pair } = extractTicker(safeText);
  const direction = extractDirection(safeText);
  const timeframe = extractTimeframe(safeText);
  const structure = extractStructure(safeText);
  const indicators = extractIndicators(safeText);
  const { sentiment, confidence: sentimentConfidence, matchedTerms } = extractSentiment(safeText);
  const priceMentioned = extractPriceMentioned(safeText);
  const signalType = extractSignalType(structure);
  const messageType = extractMessageType(safeText, { ticker });
  const language = detectLanguage(safeText);

  const features = buildFeatureVector({ ticker, pair, direction, timeframe, structure, indicators, hasLink: URL_REGEX.test(safeText), priceMentioned });
  const confidenceBreakdown = computeConfidenceBreakdown({ ticker, direction, timeframe, priceMentioned, structure, indicators, signalType });

  return {
    classifierName: CLASSIFIER_NAME,
    classifierVersion: CLASSIFIER_VERSION,
    ticker,
    pair,
    direction,
    timeframe,
    priceMentioned,
    signalType,
    messageType,
    sentiment,
    sentimentConfidence,
    language,
    keywords: matchedTerms,
    features,
    confidenceBreakdown: confidenceBreakdown.breakdown,
    confidence: confidenceBreakdown.confidence,
    isRelevant: !NOT_RELEVANT_TYPES.has(messageType),
    isCall: Boolean(ticker && direction),
  };
}

module.exports = { classify, CLASSIFIER_NAME, CLASSIFIER_VERSION };

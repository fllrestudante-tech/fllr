// Asset Explorer -- lista o Universe e, por símbolo, junta Identity
// (lib/knowledgeBase/assetStore), Statistics (assetStatisticsStore),
// Features Ativas (lib/featureBuilder), Coverage/Freshness/Sanity (mesmas
// funções de collectorReader.js). "History" fica indisponível de propósito
// -- não existe snapshot histórico de statistics/features persistido ainda.
const { DEFAULT_DB_PATH } = require("../infra/db");
const { withReadonlyDb } = require("../infra/withReadonlyDb");
const { getUniverse } = require("../universe");
const { getAsset } = require("../knowledgeBase/assetStore");
const { getAssetStatistics } = require("../knowledgeBase/assetStatisticsStore");
const { sampleCoverage } = require("../dataCoverage");
const { sampleSanityChecks } = require("../sanityChecks");
const { readFeaturesForSymbol } = require("./featureReader");
const { loadClosedTrades } = require("./tradingReader");
const { readReplayStats } = require("./replayReader");
const config = require("../../config");

const DEFAULT_STATISTICS_WINDOW_DAYS = 7;

function readAssetsList({ symbols } = {}) {
  return symbols ?? getUniverse().symbols;
}

/**
 * Trades hoje não carregam `symbol` em trades.jsonl (o bot sempre operou 1
 * símbolo só, `config.symbol` -- nunca precisou marcar qual). Regra do
 * plano: simplificar a interface em vez de inventar/expandir o schema por
 * conta própria. Pra `config.symbol` (o único que tem trade real hoje),
 * mostramos os trades reais; pra qualquer outro símbolo, honestamente vazio.
 */
function readTradesForSymbol(symbol) {
  if (symbol !== config.symbol) return { available: false, reason: "trades.jsonl não marca símbolo por trade -- só config.symbol tem histórico atribuível hoje", trades: [] };
  return { available: true, trades: loadClosedTrades().slice(-20) };
}

function readAsset(symbol, { dbPath = DEFAULT_DB_PATH, statisticsWindowDays = DEFAULT_STATISTICS_WINDOW_DAYS } = {}) {
  const result = withReadonlyDb(
    dbPath,
    (db) => ({
      identity: getAsset(db, symbol),
      statistics: getAssetStatistics(db, symbol, "global", statisticsWindowDays),
      features: readFeaturesForSymbol(db, symbol),
      coverage: sampleCoverage("candles", db, { symbol }),
      sanity: sampleSanityChecks("candles", db, { windowMs: 60 * 60 * 1000, symbol }),
    }),
    { identity: null, statistics: null, features: [], coverage: null, sanity: null }
  );

  return {
    symbol,
    ...result,
    trades: readTradesForSymbol(symbol),
    replay: readReplayStats(), // sem breakdown por símbolo hoje -- Replay ainda roda sobre config.symbol
    history: { available: false, reason: "sem snapshot histórico persistido de statistics/features ainda" },
  };
}

module.exports = { readAssetsList, readAsset, readTradesForSymbol };

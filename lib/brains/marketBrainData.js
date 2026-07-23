// Camada de I/O fina do Market Brain -- lê o que já está em data/market.db
// (sem coleta nova) e monta a forma que lib/brains/marketBrain.js::analyzeMarket
// espera. Recebe `db` já aberto (mesmo padrão de lib/dataCoverage.js/
// lib/temporalGaps.js: quem abre/fecha a conexão é o chamador).
const candleHistory = require("../candleHistory");
const config = require("../../config");

function readLatestFearGreedHistory(db, { limit = 7 } = {}) {
  return db.prepare(`SELECT value, classification, snapshot_time FROM fear_greed ORDER BY snapshot_time DESC LIMIT ?`).all(limit);
}

function readLatestFunding(db, { symbol }) {
  const row = db.prepare(`SELECT funding_rate FROM funding WHERE symbol = ? ORDER BY funding_time DESC LIMIT 1`).get(symbol);
  return row ? row.funding_rate : null;
}

// % de variação entre o oi_value mais recente e o mais antigo dentro dos
// últimos `periods` pontos amostrados -- não é uma média/regressão, só a
// leitura mais simples que já responde "subindo ou caindo".
function readOpenInterestTrend(db, { symbol, periods = 6 }) {
  const rows = db.prepare(`SELECT oi_value FROM open_interest WHERE symbol = ? ORDER BY snapshot_time DESC LIMIT ?`).all(symbol, periods);
  if (rows.length < 2 || rows[rows.length - 1].oi_value === 0) return null;
  const latest = rows[0].oi_value;
  const oldest = rows[rows.length - 1].oi_value;
  return ((latest - oldest) / oldest) * 100;
}

function readLongShortSkew(db, { symbol }) {
  const row = db.prepare(`SELECT buy_ratio FROM long_short_ratio WHERE symbol = ? ORDER BY snapshot_time DESC LIMIT 1`).get(symbol);
  return row ? row.buy_ratio - 0.5 : null;
}

// btc_dominance é global (sem coluna symbol) -- não filtra por símbolo.
function readDominanceTrend(db, { periods = 6 } = {}) {
  const rows = db.prepare(`SELECT btc_dominance_pct FROM btc_dominance ORDER BY snapshot_time DESC LIMIT ?`).all(periods);
  if (rows.length < 2 || rows[rows.length - 1].btc_dominance_pct === 0) return null;
  const latest = rows[0].btc_dominance_pct;
  const oldest = rows[rows.length - 1].btc_dominance_pct;
  return ((latest - oldest) / oldest) * 100;
}

/**
 * Candles pro eixo tendência reaproveitam lib/candleHistory.js::getBacktestCandles
 * direto -- mesma função do item 1 do sequenciamento (maior trecho contíguo
 * dentro de config.backtestDbLookbackDays). `null` (trecho insuficiente)
 * vira `closes: []`, que lib/brains/marketBrain.js::classifyTrend já trata
 * como "dado histórico insuficiente" sem quebrar.
 */
function gatherMarketBrainInputs(db, { symbol, interval }) {
  const intervalMinutes = Number(interval) || 1;
  const candlesResult = candleHistory.getBacktestCandles(db, {
    symbol,
    interval,
    intervalMinutes,
    lookbackDays: config.backtestDbLookbackDays,
    minCandles: 200,
  });

  return {
    closes: candlesResult ? candlesResult.candles.map((c) => c[4]) : [],
    fearGreedHistory: readLatestFearGreedHistory(db),
    fundingRate: readLatestFunding(db, { symbol }),
    oiTrendPct: readOpenInterestTrend(db, { symbol }),
    longShortSkew: readLongShortSkew(db, { symbol }),
    dominanceTrendPct: readDominanceTrend(db),
  };
}

module.exports = {
  readLatestFearGreedHistory,
  readLatestFunding,
  readOpenInterestTrend,
  readLongShortSkew,
  readDominanceTrend,
  gatherMarketBrainInputs,
};

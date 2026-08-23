// Página Trading -- só consome lib/tradingHealth.js/lib/exitAnalytics.js
// (já existentes) + as derivações puras deste diretório (equityCurve,
// periodGrouping). Nenhuma regra de negócio nova, nenhuma métrica
// recalculada fora do módulo que já é dono dela.
const config = require("../../config");
const { readTradeEvents, extractClosedTrades, computeTradingHealth } = require("../tradingHealth");
const { computeExitAnalytics } = require("../exitAnalytics");
const { computeEquityCurve, computeEquityCandles } = require("./equityCurve");
const { computeTradingHealthForWindow, groupTradesByPeriod } = require("./periodGrouping");

function loadClosedTrades(filePath = config.paths.tradesLog) {
  return extractClosedTrades(readTradeEvents(filePath));
}

/**
 * Card de Capital -- derivação aritmética sobre os mesmos trades fechados
 * (soma/min/max de pnlUsd), não um cálculo de negócio novo.
 */
function computeCapitalSummary(trades) {
  if (trades.length === 0) {
    return { totalPnlUsd: 0, biggestWinUsd: null, biggestLossUsd: null, tradesAnalyzed: 0 };
  }
  const pnls = trades.map((t) => (typeof t.pnlUsd === "number" ? t.pnlUsd : 0));
  return {
    totalPnlUsd: pnls.reduce((a, b) => a + b, 0),
    biggestWinUsd: Math.max(...pnls),
    biggestLossUsd: Math.min(...pnls),
    tradesAnalyzed: trades.length,
  };
}

/**
 * `/api/v1/trading?window=...` -- window default "all". Reusa
 * computeTradingHealth (all-time, com portfolioAnalytics/exitAnalytics
 * completos) quando window==="all"; janelas menores usam
 * computeTradingHealthForWindow (subconjunto de métricas, mas as mesmas
 * funções por baixo).
 */
function readTrading({ window = "all", filePath = config.paths.tradesLog } = {}) {
  const trades = loadClosedTrades(filePath);

  const metrics = window === "all" ? computeTradingHealth(filePath) : computeTradingHealthForWindow(trades, window);

  return {
    window,
    metrics,
    equityCurve: computeEquityCurve(trades),
    equityCandles: computeEquityCandles(trades, "day"),
    capital: computeCapitalSummary(trades),
    lucroPorDia: groupTradesByPeriod(trades, "day"),
    lucroPorMes: groupTradesByPeriod(trades, "month"),
    exitAnalytics: computeExitAnalytics(trades),
  };
}

/**
 * Cards "Hoje" / "All Time" lado a lado na Overview -- 2 chamadas da mesma
 * função, não um conceito novo.
 */
function readTodayVsAllTime({ filePath = config.paths.tradesLog } = {}) {
  const trades = loadClosedTrades(filePath);
  return {
    today: computeTradingHealthForWindow(trades, "today"),
    allTime: computeTradingHealthForWindow(trades, "all"),
  };
}

module.exports = { loadClosedTrades, computeCapitalSummary, readTrading, readTodayVsAllTime };

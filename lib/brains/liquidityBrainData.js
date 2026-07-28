// Camada de I/O fina do Liquidity Brain -- espelha lib/brains/structureBrainData.js.
const candleHistory = require("../candleHistory");
const config = require("../../config");
const { buildLiquidityContext } = require("../knowledgeBase/contextBuilder");

function gatherLiquidityBrainInputs(db, { symbol, interval }) {
  const intervalMinutes = Number(interval) || 1;
  const candlesResult = candleHistory.getBacktestCandles(db, {
    symbol,
    interval,
    intervalMinutes,
    lookbackDays: config.backtestDbLookbackDays,
    minCandles: 200,
  });
  const { context } = buildLiquidityContext(db, symbol);

  return {
    candles: candlesResult ? candlesResult.candles : [],
    lookback: context.lookback,
    equalTolerancePct: context.equalTolerancePct,
    sweepReversalLookahead: context.sweepReversalLookahead,
  };
}

module.exports = { gatherLiquidityBrainInputs };

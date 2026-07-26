// Camada de I/O fina do Liquidity Brain -- espelha lib/brains/structureBrainData.js.
const candleHistory = require("../candleHistory");
const config = require("../../config");

function gatherLiquidityBrainInputs(db, { symbol, interval }) {
  const intervalMinutes = Number(interval) || 1;
  const candlesResult = candleHistory.getBacktestCandles(db, {
    symbol,
    interval,
    intervalMinutes,
    lookbackDays: config.backtestDbLookbackDays,
    minCandles: 200,
  });

  return {
    candles: candlesResult ? candlesResult.candles : [],
    lookback: config.structure.lookback,
    equalTolerancePct: config.structure.equalTolerancePct,
    sweepReversalLookahead: config.structure.sweepReversalLookahead,
  };
}

module.exports = { gatherLiquidityBrainInputs };

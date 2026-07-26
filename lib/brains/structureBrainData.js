// Camada de I/O fina do Structure Brain -- espelha lib/brains/marketBrainData.js.
// Recebe `db` já aberto (mesmo padrão de todo o projeto: quem abre/fecha a
// conexão é o chamador).
const candleHistory = require("../candleHistory");
const config = require("../../config");

function gatherStructureBrainInputs(db, { symbol, interval }) {
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
  };
}

module.exports = { gatherStructureBrainInputs };

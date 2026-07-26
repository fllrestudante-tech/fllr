// Camada de I/O do Order Block Brain -- mesma orquestração do
// fvgBrainData.js (Market/Structure/Liquidity Brain + Context Fusion +
// candles), pois Order Block Brain também precisa desses Brains como
// contexto (ver lib/brains/orderBlockBrain.js).
const candleHistory = require("../candleHistory");
const config = require("../../config");
const marketBrainData = require("./marketBrainData");
const marketBrain = require("./marketBrain");
const structureBrainData = require("./structureBrainData");
const structureBrain = require("./structureBrain");
const liquidityBrainData = require("./liquidityBrainData");
const liquidityBrain = require("./liquidityBrain");
const { fuseContext } = require("./contextFusion");

function gatherOrderBlockBrainInputs(db, { symbol, interval }) {
  const intervalMinutes = Number(interval) || 1;
  const candlesResult = candleHistory.getBacktestCandles(db, {
    symbol,
    interval,
    intervalMinutes,
    lookbackDays: config.backtestDbLookbackDays,
    minCandles: 200,
  });

  const market = marketBrain.analyzeMarket(marketBrainData.gatherMarketBrainInputs(db, { symbol, interval }));
  const structure = structureBrain.analyzeStructure(structureBrainData.gatherStructureBrainInputs(db, { symbol, interval }));
  const liquidity = liquidityBrain.analyzeLiquidity(liquidityBrainData.gatherLiquidityBrainInputs(db, { symbol, interval }));
  const context = fuseContext({ market, structure, liquidity });

  return {
    candles: candlesResult ? candlesResult.candles : [],
    structure,
    liquidity,
    context,
    confirmAge: config.structure.confirmAge,
    mitigationThreshold: config.structure.mitigationThreshold,
    exhaustionLookback: config.structure.exhaustionLookback,
  };
}

module.exports = { gatherOrderBlockBrainInputs };

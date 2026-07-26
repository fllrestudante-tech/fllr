// Camada de I/O do FVG Brain -- diferente dos outros *BrainData.js (que só
// buscam candles), este também orquestra Market/Structure/Liquidity Brain
// + Context Fusion, porque o FVG Brain precisa deles como contexto (ver
// lib/brains/fvgBrain.js). Mesma orquestração que scripts/health.js já
// fazia manualmente pra montar a seção de Context Fusion.
const candleHistory = require("../candleHistory");
const config = require("../../config");
const marketBrainData = require("./marketBrainData");
const marketBrain = require("./marketBrain");
const structureBrainData = require("./structureBrainData");
const structureBrain = require("./structureBrain");
const liquidityBrainData = require("./liquidityBrainData");
const liquidityBrain = require("./liquidityBrain");
const { fuseContext } = require("./contextFusion");

function gatherFVGBrainInputs(db, { symbol, interval }) {
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
    exhaustionLookback: config.structure.exhaustionLookback,
  };
}

module.exports = { gatherFVGBrainInputs };

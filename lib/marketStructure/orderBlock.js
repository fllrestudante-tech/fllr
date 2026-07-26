// Order Block — geometria pura, sem contexto (quem julga qualidade é
// lib/brains/orderBlockBrain.js). Em vez de reimplementar detecção de
// impulso do zero, se apoia direto nos eventos BOS já detectados pelo
// Structure Brain (lib/marketStructure/structureEvidence.js) -- Order
// Block clássico (ICT/SMC) vem de CONTINUAÇÃO de estrutura, não de
// reversão (CHOCH fica de fora, documentado).
const DEFAULT_MAX_LOOKBACK = 20;

/**
 * Pra cada BOS, anda pra trás a partir do candle impulsivo procurando o
 * primeiro candle de cor OPOSTA à direção do BOS -- pula candles da mesma
 * direção do impulso (eles fazem parte do próprio movimento impulsivo,
 * não são candidatos a Order Block), só para quando acha o oposto ou
 * estoura `maxLookback` candles pra trás (nunca fabrica um bloco
 * arbitrariamente distante do impulso que o originou).
 */
function detectOrderBlocks(candles, structureEvidence, { maxLookback = DEFAULT_MAX_LOOKBACK } = {}) {
  const bosEvents = structureEvidence.filter((e) => e.type === "BOS");
  const blocks = [];

  for (const event of bosEvents) {
    const impulseIndex = event.payload.candleIndex;
    const direction = event.payload.direction;
    let obIndex = null;

    for (let i = impulseIndex - 1; i >= 0 && impulseIndex - i <= maxLookback; i--) {
      const open = parseFloat(candles[i][1]);
      const close = parseFloat(candles[i][4]);
      const isOpposite = direction === "bullish" ? close < open : close > open;
      if (isOpposite) {
        obIndex = i;
        break;
      }
    }

    if (obIndex === null) continue;
    blocks.push({
      direction,
      createdIndex: obIndex,
      confirmedAtIndex: impulseIndex,
      low: parseFloat(candles[obIndex][3]),
      high: parseFloat(candles[obIndex][2]),
    });
  }

  return blocks;
}

/**
 * Varre candles depois da confirmação: `touched` (sobreposição com a
 * zona), `maxPenetrationPct` (0-1, quanto da zona já foi "comida" pelo
 * lado oposto -- métrica contínua, não binário tocado/preenchido como o
 * FVG), `brokenAtIndex` (primeiro close além da borda mais distante da
 * criação -- estrutura violada de verdade).
 */
function trackBlockLifecycleData(block, candles) {
  const zoneSize = block.high - block.low;
  let touched = false;
  let maxPenetrationPct = 0;
  let brokenAtIndex = null;

  for (let i = block.confirmedAtIndex + 1; i < candles.length; i++) {
    const low = parseFloat(candles[i][3]);
    const high = parseFloat(candles[i][2]);
    const close = parseFloat(candles[i][4]);

    if (high > block.low && low < block.high) touched = true;

    let penetration = 0;
    if (block.direction === "bullish") {
      if (low < block.high) penetration = Math.min(1, (block.high - Math.max(low, block.low)) / zoneSize);
    } else {
      if (high > block.low) penetration = Math.min(1, (Math.min(high, block.high) - block.low) / zoneSize);
    }
    maxPenetrationPct = Math.max(maxPenetrationPct, penetration);

    const brokenNow = block.direction === "bullish" ? close < block.low : close > block.high;
    if (brokenNow) {
      brokenAtIndex = i;
      break;
    }
  }

  return { touched, maxPenetrationPct, brokenAtIndex };
}

module.exports = { detectOrderBlocks, trackBlockLifecycleData };

// Fair Value Gap (FVG) — geometria pura, sem contexto nenhum (quem julga
// qualidade/prioridade é lib/brains/fvgBrain.js, que recebe Structure/
// Liquidity/Context Fusion). Fractal clássico de 3 candles: o candle `i`
// é o "impulsivo" que deixa um desequilíbrio entre `i-1` e `i+1`.
function detectFVGs(candles) {
  const gaps = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prevHigh = parseFloat(candles[i - 1][2]);
    const prevLow = parseFloat(candles[i - 1][3]);
    const nextHigh = parseFloat(candles[i + 1][2]);
    const nextLow = parseFloat(candles[i + 1][3]);

    if (nextLow > prevHigh) {
      gaps.push({ direction: "bullish", createdIndex: i, low: prevHigh, high: nextLow });
    } else if (nextHigh < prevLow) {
      gaps.push({ direction: "bearish", createdIndex: i, low: nextHigh, high: prevLow });
    }
  }
  return gaps;
}

/**
 * Varre os candles depois da confirmação do gap (createdIndex+2 em diante
 * -- o candle createdIndex+1 é o que define a borda distante, não conta
 * como "depois"). `touched` = algum candle sobrepõe a zona. `filled` =
 * preço volta até a borda mais distante da criação (a "far edge" -- low
 * do gap pro bullish, high do gap pro bearish; retraçar até lá "fecha" o
 * desequilíbrio inteiro, não só encosta nele).
 */
function trackFillState(gap, candles) {
  let touched = false;
  let filled = false;
  let filledAtIndex = null;

  for (let i = gap.createdIndex + 2; i < candles.length; i++) {
    const low = parseFloat(candles[i][3]);
    const high = parseFloat(candles[i][2]);

    if (high > gap.low && low < gap.high) touched = true;

    if (gap.direction === "bullish" && low <= gap.low) {
      filled = true;
      filledAtIndex = i;
      break;
    }
    if (gap.direction === "bearish" && high >= gap.high) {
      filled = true;
      filledAtIndex = i;
      break;
    }
  }

  return { touched, filled, filledAtIndex };
}

module.exports = { detectFVGs, trackFillState };

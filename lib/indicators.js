function calcEMA(prices, period) {
  if (!prices || prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcSMA(prices, period) {
  if (!prices || prices.length < period) return 0;
  const slice = prices.slice(prices.length - period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// Stochastic RSI (simplified)
function calcStochRSI(rsiValues, period = 14) {
  if (!rsiValues || rsiValues.length < period) return 50;
  const slice = rsiValues.slice(rsiValues.length - period);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const last = slice[slice.length - 1];
  if (max - min === 0) return 50;
  return ((last - min) / (max - min)) * 100;
}

// RSI (simple implementation)
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Volume Weighted OBV (simplified) — candles: [openTime, open, high, low, close, volume, ...]
function calcOBV(candles) {
  if (!candles || candles.length === 0) return 0;
  let obv = 0;
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1][4];
    const close = candles[i][4];
    const volume = parseFloat(candles[i][5] || 0);
    if (close > prevClose) obv += volume;
    else if (close < prevClose) obv -= volume;
  }
  return obv;
}

// Average True Range — usado pelo risk manager para dimensionar o stop-loss
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  const slice = trueRanges.slice(trueRanges.length - period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

module.exports = { calcEMA, calcSMA, calcStochRSI, calcRSI, calcOBV, calcATR };

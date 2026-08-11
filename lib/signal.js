const fs = require("fs");
const config = require("../config");
const { calcEMA, calcRSI, calcStochRSI, calcOBV, calcATR } = require("./indicators");

// Parâmetros padrão (mesmos valores do bot original) — usados até o primeiro
// backtest gerar data/tuning.json, e como fallback caso o arquivo esteja corrompido.
const DEFAULT_PARAMS = {
  emaShort: 8,
  emaLong: 56,
  rsiPeriod: 14,
  stochOversold: 20,
  stochOverbought: 80,
  stopLossPct: 0.025,
  updatedAt: null,
  source: "default",
};

function loadParams() {
  if (!fs.existsSync(config.paths.tuningFile)) {
    return { ...DEFAULT_PARAMS };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(config.paths.tuningFile, "utf8"));
    return { ...DEFAULT_PARAMS, ...raw.current };
  } catch (err) {
    console.error("⚠️  tuning.json corrompido, usando parâmetros padrão:", err.message);
    return { ...DEFAULT_PARAMS };
  }
}

/**
 * Confluência EMA/RSI/StochRSI/OBV — mesma lógica do bot original,
 * agora parametrizável (períodos vêm do tuning.json em vez de constantes fixas).
 */
function analyze(candles, params = loadParams()) {
  if (!candles || candles.length === 0) return { signal: "wait", reasons: ["no_data"] };

  const closes = candles.map((c) => parseFloat(c[4]));
  const ema8 = calcEMA(closes, params.emaShort);
  const ema56 = calcEMA(closes, params.emaLong);
  const rsi = calcRSI(closes, params.rsiPeriod);

  const rsiArray = [];
  for (let i = params.rsiPeriod + 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    rsiArray.push(calcRSI(slice, params.rsiPeriod));
  }
  const stoch = calcStochRSI(rsiArray.length ? rsiArray : [rsi], params.rsiPeriod);
  const obv = calcOBV(candles);
  const atr = calcATR(candles, 14);

  const reasons = [];
  let signal = "wait";

  const emaCrossBuy = ema8 > ema56;
  const emaCrossSell = ema8 < ema56;
  const stochBuy = stoch < params.stochOversold;
  const stochSell = stoch > params.stochOverbought;
  const rsiOkBuy = rsi > 30 && rsi < 50;
  const rsiOkSell = rsi > 50 && rsi < 70;
  const obvUp = obv > 0;

  if (emaCrossBuy && stochBuy && rsiOkBuy && obvUp) {
    signal = "buy";
    reasons.push("ema_cross_up", "stoch_oversold", "rsi_ok", "obv_up");
  } else if (emaCrossSell && stochSell && rsiOkSell && !obvUp) {
    signal = "sell";
    reasons.push("ema_cross_down", "stoch_overbought", "rsi_ok", "obv_down");
  } else {
    if (emaCrossBuy) reasons.push("ema_up");
    if (emaCrossSell) reasons.push("ema_down");
    if (stochBuy) reasons.push("stoch_buy");
    if (stochSell) reasons.push("stoch_sell");
    if (rsiOkBuy) reasons.push("rsi_buy_zone");
    if (rsiOkSell) reasons.push("rsi_sell_zone");
    if (obvUp) reasons.push("obv_up");
  }

  const price = closes[closes.length - 1];

  return { signal, reasons, price, ema8, ema56, rsi, stoch, obv, atr, params };
}

module.exports = { analyze, loadParams, DEFAULT_PARAMS };

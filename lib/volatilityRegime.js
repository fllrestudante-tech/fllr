// Proxy leve de regime de volatilidade -- só ATR, sem fonte de dado nova.
// Não é o Market Quality Engine (aquele mede qualidade do dado coletado,
// não regime de mercado) nem o futuro classificador de regime bull/bear/
// lateral da Fase E/G -- é um placeholder propositalmente simples, reusado
// pelo circuit breaker (D2) e pelo trailing adaptativo (D4).
const DEFAULT_PERIOD = 14;
const DEFAULT_LOOKBACK = 50;
const HIGH_MULTIPLIER = 2; // ATR atual > 2x a média do lookback -> HIGH
const LOW_MULTIPLIER = 0.5; // ATR atual < 0.5x a média do lookback -> LOW

function trueRangeSeries(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const high = parseFloat(candles[i][2]);
    const low = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i - 1][4]);
    out[i] = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return out;
}

// ATR em cada ponto i = média simples dos últimos `period` true ranges
// terminando em i (mesma convenção de lib/indicators.js::calcATR, só que
// pra série inteira em vez de um único valor no final).
function atrSeries(candles, period = DEFAULT_PERIOD) {
  const tr = trueRangeSeries(candles);
  const out = new Array(candles.length).fill(0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += tr[j];
    out[i] = sum / period;
  }
  return out;
}

function classifyAt(atr, index, lookback) {
  if (index < lookback) return "NORMAL"; // amostra insuficiente pra média confiável -- não classifica como extremo por padrão
  let sum = 0;
  for (let j = index - lookback; j < index; j++) sum += atr[j];
  const avg = sum / lookback;
  if (avg === 0) return "NORMAL";
  const current = atr[index];
  if (current > avg * HIGH_MULTIPLIER) return "HIGH";
  if (current < avg * LOW_MULTIPLIER) return "LOW";
  return "NORMAL";
}

// Classificação do ponto mais recente -- uso ao vivo (1 chamada por ciclo).
function classifyVolatility(candles, { period = DEFAULT_PERIOD, lookback = DEFAULT_LOOKBACK } = {}) {
  if (!candles || candles.length === 0) return "NORMAL";
  const atr = atrSeries(candles, period);
  return classifyAt(atr, candles.length - 1, lookback);
}

// Classificação candle a candle -- uso no backtest (lib/backtest.js::simulate),
// pra manter o auto-tuning validando contra o mesmo gatilho que a produção usa.
function classifyVolatilitySeries(candles, { period = DEFAULT_PERIOD, lookback = DEFAULT_LOOKBACK } = {}) {
  const atr = atrSeries(candles, period);
  const out = new Array(candles.length).fill("NORMAL");
  for (let i = 0; i < candles.length; i++) out[i] = classifyAt(atr, i, lookback);
  return out;
}

module.exports = {
  atrSeries,
  classifyVolatility,
  classifyVolatilitySeries,
  DEFAULT_PERIOD,
  DEFAULT_LOOKBACK,
  HIGH_MULTIPLIER,
  LOW_MULTIPLIER,
};

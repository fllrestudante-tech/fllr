// Monta uma série de candles utilizável pro backtest a partir do que já foi
// coletado em data/market.db -- distinto de lib/dataCoverage.js/temporalGaps.js
// (que medem qualidade de coleta), este módulo serve dado de verdade pro
// simulate()/buildSignals() de lib/backtest.js. Reaproveita
// lib/temporalGaps.js::detectGaps (mesma régua de tolerância do Market
// Quality Engine) e só adiciona o que faltava: escolher o maior trecho
// contíguo entre os gaps -- indicadores calculados através de um gap real
// (ex: coletor fora do ar por horas) produziriam EMA/RSI sem sentido, como
// se os candles fossem consecutivos quando não são.
const { detectGaps } = require("./temporalGaps");

/**
 * Pura, sem I/O. `rows` precisa estar ordenado por open_time ASC. Usa
 * detectGaps pra achar os pontos de corte, depois escolhe a fatia mais longa
 * entre dois cortes consecutivos (ou do início/fim até o corte mais
 * próximo). Sem nenhum gap, a fatia é o array inteiro.
 */
function longestContiguousRun(rows, expectedIntervalMs, toleranceMultiplier = 2) {
  if (rows.length === 0) return [];
  const timestamps = rows.map((r) => r.open_time);
  const gaps = detectGaps(timestamps, expectedIntervalMs, toleranceMultiplier);

  const cutTimestamps = gaps.map((g) => g.toMs); // início de cada trecho novo depois de um gap
  const boundaries = [0, ...cutTimestamps.map((t) => timestamps.indexOf(t)), rows.length];

  let bestStart = 0;
  let bestLength = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const length = end - start;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }

  return rows.slice(bestStart, bestStart + bestLength);
}

function toArrayFormat(rows) {
  return rows.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume]);
}

function readCandlesFromDb(db, { symbol, interval, sinceMs, untilMs }) {
  return db
    .prepare(
      `SELECT open_time, open, high, low, close, volume FROM candles
       WHERE symbol = ? AND interval = ? AND open_time BETWEEN ? AND ?
       ORDER BY open_time ASC`
    )
    .all(symbol, interval, sinceMs, untilMs);
}

/**
 * Orquestra: lê a janela de `lookbackDays` pra trás, acha o maior trecho
 * contíguo, devolve no formato posicional que simulate()/buildSignals() já
 * esperam. `null` quando não há trecho contíguo suficiente ainda (ou tabela
 * vazia) -- sinal explícito pro chamador cair pro fallback ao vivo, nunca
 * um array vazio/parcial fingindo ser dado válido.
 */
function getBacktestCandles(db, { symbol, interval, intervalMinutes, lookbackDays, minCandles }) {
  const now = Date.now();
  const sinceMs = now - lookbackDays * 24 * 60 * 60 * 1000;
  const rows = readCandlesFromDb(db, { symbol, interval, sinceMs, untilMs: now });
  if (rows.length < minCandles) return null;

  const expectedIntervalMs = intervalMinutes * 60000;
  const run = longestContiguousRun(rows, expectedIntervalMs);
  if (run.length < minCandles) return null;

  return {
    candles: toArrayFormat(run),
    windowStart: run[0].open_time,
    windowEnd: run[run.length - 1].open_time,
  };
}

module.exports = { longestContiguousRun, toArrayFormat, readCandlesFromDb, getBacktestCandles };

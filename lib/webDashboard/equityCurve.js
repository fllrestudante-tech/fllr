// Soma cumulativa sobre trades já fechados -- derivação aritmética, não
// interpretação nova (mesmo nível de lib/tradingHealth.js::computeMetrics,
// que já reduz o mesmo array de trades a agregados). Usa pnlUsd quando
// disponível (mais preciso pra "capital"), cai pra pnlPct*entryNotional
// quando não -- mas hoje trades.jsonl sempre grava pnlUsd nos eventos de
// fechamento (ver lib/tradeLifecycle.js), então o fallback raramente ativa.
function computeEquityCurve(trades) {
  let cumulative = 0;
  return trades.map((t) => {
    cumulative += typeof t.pnlUsd === "number" ? t.pnlUsd : 0;
    return { time: t.time, pnlUsd: t.pnlUsd ?? 0, cumulativePnlUsd: cumulative };
  });
}

// OHLC diário (ou mensal) sobre o mesmo capital acumulado de
// computeEquityCurve, pra render em candlestick no dashboard (ver
// feedback_graficos_estilo_candlestick: gráfico de preço nunca em linha
// reta). "high"/"low" são o máximo/mínimo do capital acumulado atingido
// naquele período -- não existe "vela" fora de um trade (o capital só muda
// quando um trade fecha), então dá pra derivar isso 100% do mesmo array de
// pontos já produzido por computeEquityCurve, sem novo dado nenhum.
function computeEquityCandles(trades, unit = "day") {
  const curve = computeEquityCurve(trades);
  const groups = {};
  const order = [];
  let runningBefore = 0;

  for (const point of curve) {
    if (typeof point.time !== "string") continue;
    const key = unit === "month" ? point.time.slice(0, 7) : point.time.slice(0, 10);
    if (!groups[key]) {
      groups[key] = { period: key, open: runningBefore, high: runningBefore, low: runningBefore, close: runningBefore, trades: 0 };
      order.push(key);
    }
    const g = groups[key];
    g.close = point.cumulativePnlUsd;
    g.high = Math.max(g.high, point.cumulativePnlUsd);
    g.low = Math.min(g.low, point.cumulativePnlUsd);
    g.trades++;
    runningBefore = point.cumulativePnlUsd;
  }

  return order.map((k) => groups[k]);
}

module.exports = { computeEquityCurve, computeEquityCandles };

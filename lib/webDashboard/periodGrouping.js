// Derivações puras sobre trades já fechados (mesmo array que
// lib/tradingHealth.js::extractClosedTrades já produz) -- reusa
// computeMetrics (lib/backtest.js, mesma função do auto-tuning) e
// computeMaxDrawdownFromReturns/computeSampleConfidence (lib/tradingHealth.js)
// em vez de redefinir Profit Factor/Win Rate/Drawdown. Regra do plano: só
// agregação/agrupamento temporal aqui, nenhuma regra de negócio nova.
const { computeMetrics } = require("../backtest");
const { computeMaxDrawdownFromReturns } = require("../tradingHealth");
const { computeSampleConfidence } = require("../sampleConfidence");

const WINDOW_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

function filterTradesSince(trades, sinceMs) {
  return trades.filter((t) => typeof t.time === "string" && new Date(t.time).getTime() >= sinceMs);
}

// "today" é calendário (meia-noite UTC até agora), não uma janela rolante de
// 24h -- é o que "hoje" significa pra quem está olhando o dashboard, mesma
// convenção UTC que o resto do projeto já usa (dailyLossDate em lib/state.js).
function startOfUtcDay(nowMs) {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function summarize(windowTrades) {
  const pnlPcts = windowTrades.map((t) => t.pnlPct);
  const maxDrawdown = computeMaxDrawdownFromReturns(pnlPcts);
  return {
    ...computeMetrics(pnlPcts, maxDrawdown),
    sampleConfidence: computeSampleConfidence(windowTrades.length),
    tradesAnalyzed: windowTrades.length,
  };
}

/**
 * `windowKey` -- "today"/"7d"/"30d"/"90d"/"all". Lança erro em chave
 * desconhecida (falha alto/rápido, não silencia um typo de rota).
 */
function computeTradingHealthForWindow(trades, windowKey, now = Date.now()) {
  if (windowKey === "all") return summarize(trades);
  if (windowKey === "today") return summarize(filterTradesSince(trades, startOfUtcDay(now)));
  const days = WINDOW_DAYS[windowKey];
  if (!days) throw new Error(`janela inválida: "${windowKey}" -- use uma de: today, 7d, 30d, 90d, all`);
  return summarize(filterTradesSince(trades, now - days * 24 * 60 * 60 * 1000));
}

/**
 * Soma de pnlUsd por dia (`unit:"day"`, chave YYYY-MM-DD) ou mês
 * (`unit:"month"`, chave YYYY-MM), ordenado cronologicamente.
 */
function groupTradesByPeriod(trades, unit = "day") {
  const groups = {};
  for (const t of trades) {
    if (typeof t.time !== "string") continue;
    const key = unit === "month" ? t.time.slice(0, 7) : t.time.slice(0, 10);
    if (!groups[key]) groups[key] = { period: key, pnlUsd: 0, trades: 0 };
    groups[key].pnlUsd += typeof t.pnlUsd === "number" ? t.pnlUsd : 0;
    groups[key].trades++;
  }
  return Object.values(groups).sort((a, b) => a.period.localeCompare(b.period));
}

module.exports = { computeTradingHealthForWindow, groupTradesByPeriod, WINDOW_DAYS };

// Trading Health -- lê trades REAIS de data/trades.jsonl (Demo Trading) e
// agrega estatísticas de saúde da estratégia. Read-only: não decide
// entradas, não muda risco, não influencia o bot -- só informa se a
// estratégia continua saudável ou degradando. Reusa lib/backtest.js's
// computeMetrics de verdade (mesma função do auto-tuning) em vez de
// reimplementar Win Rate/Profit Factor/Expectancy/Sharpe.
const fs = require("fs");
const config = require("../config");
const { computeMetrics } = require("./backtest");

// Só esses 2 eventos carregam pnlPct real hoje: position_closed_externally
// (fechamento por SL/TP) e order_closed_manually_pnl (fechamento manual/por
// reversão -- antes dessa fase só dava console.log, nunca era logado).
const CLOSING_EVENTS_WITH_PNL = ["position_closed_externally", "order_closed_manually_pnl"];

/**
 * Parse linha a linha -- uma linha corrompida (ex: processo morto no meio de
 * um fs.appendFileSync) não derruba a leitura do arquivo inteiro, só é
 * ignorada silenciosamente.
 */
function readTradeEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // linha corrompida, ignora
    }
  }
  return events;
}

function extractClosedTrades(events) {
  return events.filter((e) => CLOSING_EVENTS_WITH_PNL.includes(e.event) && typeof e.pnlPct === "number");
}

function computeAverageHoldMs(trades) {
  const withHold = trades.filter((t) => typeof t.holdMs === "number");
  if (withHold.length === 0) return null;
  return withHold.reduce((sum, t) => sum + t.holdMs, 0) / withHold.length;
}

/**
 * Drawdown máximo sobre a curva de equity acumulada de forma aditiva (soma
 * simples dos pnlPct, não composta) -- mesma convenção de retorno fracionário
 * simples já usada em lib/backtest.js::computeMetrics (expectancy = média
 * aritmética, não log-return).
 */
function computeMaxDrawdownFromReturns(pnlPcts) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of pnlPcts) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return maxDrawdown;
}

// --- Portfolio Analytics (parte construível agora -- mesma série de
// retornos de 1 símbolo já existente, sem precisar de multi-ativo, sinais
// múltiplos ou classificador de regime, que não existem hoje) ---

function computeSortino(pnlPcts) {
  if (pnlPcts.length === 0) return 0;
  const mean = pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length;
  const downside = pnlPcts.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const downsideVariance = downside.reduce((a, b) => a + b ** 2, 0) / pnlPcts.length;
  const downsideDeviation = Math.sqrt(downsideVariance);
  return downsideDeviation > 0 ? mean / downsideDeviation : 0;
}

function computeCalmarAndRecoveryFactor(pnlPcts, maxDrawdown) {
  const totalReturn = pnlPcts.reduce((a, b) => a + b, 0);
  if (maxDrawdown <= 0) {
    return { calmar: null, recoveryFactor: null, note: "sem drawdown registrado ainda, razão não é calculável" };
  }
  // "Calmar" tradicionalmente usa retorno ANUALIZADO -- sem meses de histórico
  // real ainda, reportar isso como retorno bruto/drawdown seria enganoso.
  // Recovery Factor não exige anualização (é só retorno líquido/drawdown).
  return { calmar: null, recoveryFactor: totalReturn / maxDrawdown, note: "calmar precisa de retorno anualizado -- ainda não há meses de histórico real suficientes" };
}

/**
 * Kelly Fraction: f* = W - (1-W)/R, onde W = win rate, R = média dos ganhos /
 * média das perdas (magnitude). Negativo é um sinal válido (estratégia não
 * deveria alavancar nesse tamanho), não um erro.
 */
function computeKellyFraction(pnlPcts) {
  const gains = pnlPcts.filter((r) => r > 0);
  const losses = pnlPcts.filter((r) => r < 0);
  if (gains.length === 0 || losses.length === 0) return null;
  const winRate = gains.length / pnlPcts.length;
  const avgWin = gains.reduce((a, b) => a + b, 0) / gains.length;
  const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length);
  if (avgLoss === 0) return null;
  const rewardRiskRatio = avgWin / avgLoss;
  return winRate - (1 - winRate) / rewardRiskRatio;
}

/**
 * VaR histórico (não paramétrico -- não assume distribuição normal): o
 * retorno no percentil (1-confidence) da amostra ordenada. CVaR é a média
 * dos retornos piores que o VaR (a cauda). Ambos null com amostra pequena
 * demais pra um percentil fazer sentido.
 */
function computeVarCvar(pnlPcts, confidence = 0.95) {
  if (pnlPcts.length < 5) return { var: null, cvar: null, confidence, note: "amostra pequena demais (<5 trades) pra um percentil ser confiável" };
  const sorted = [...pnlPcts].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  const varValue = sorted[index];
  const tail = sorted.slice(0, index + 1);
  const cvarValue = tail.reduce((a, b) => a + b, 0) / tail.length;
  return { var: varValue, cvar: cvarValue, confidence };
}

function groupByHourAndWeekday(trades) {
  const byHour = {};
  const byWeekday = {};
  for (const t of trades) {
    if (!t.time) continue;
    const d = new Date(t.time);
    const hour = d.getUTCHours();
    const weekday = d.getUTCDay(); // 0=domingo
    byHour[hour] = byHour[hour] || [];
    byHour[hour].push(t.pnlPct);
    byWeekday[weekday] = byWeekday[weekday] || [];
    byWeekday[weekday].push(t.pnlPct);
  }
  const summarize = (bucket) =>
    Object.fromEntries(
      Object.entries(bucket).map(([key, returns]) => [
        key,
        { trades: returns.length, avgPnlPct: returns.reduce((a, b) => a + b, 0) / returns.length, winRate: returns.filter((r) => r > 0).length / returns.length },
      ])
    );
  return { byHourUtc: summarize(byHour), byWeekdayUtc: summarize(byWeekday) };
}

function computeTradingHealth(filePath = config.paths.tradesLog) {
  const events = readTradeEvents(filePath);
  const trades = extractClosedTrades(events);
  const pnlPcts = trades.map((t) => t.pnlPct);

  const maxDrawdown = computeMaxDrawdownFromReturns(pnlPcts);
  const metrics = computeMetrics(pnlPcts, maxDrawdown); // reusa lib/backtest.js -- mesma função do auto-tuning

  return {
    ...metrics,
    averageHoldMs: computeAverageHoldMs(trades),
    tradesWithHoldData: trades.filter((t) => typeof t.holdMs === "number").length,
    portfolioAnalytics: {
      sortino: computeSortino(pnlPcts),
      ...computeCalmarAndRecoveryFactor(pnlPcts, maxDrawdown),
      kellyFraction: computeKellyFraction(pnlPcts),
      ...computeVarCvar(pnlPcts),
      performance: groupByHourAndWeekday(trades),
      notImplementedYet: {
        exposicaoPorAtivo: "bot opera só 1 símbolo hoje -- degenerado com n=1, aguarda multi-ativo",
        exposicaoPorNarrativa: "precisa de taxonomia ativo->narrativa, não existe ainda",
        correlacaoEntreAtivos: "aguarda multi-ativo",
        correlacaoEntreSinais: "só existe 1 fonte de sinal hoje (lib/signal.js)",
        performancePorRegime: "precisa de classificador bull/bear/lateral, não existe ainda",
      },
    },
    tradesAnalyzed: trades.length,
    sampledAt: new Date().toISOString(),
  };
}

module.exports = {
  readTradeEvents,
  extractClosedTrades,
  computeAverageHoldMs,
  computeMaxDrawdownFromReturns,
  computeSortino,
  computeCalmarAndRecoveryFactor,
  computeKellyFraction,
  computeVarCvar,
  groupByHourAndWeekday,
  computeTradingHealth,
};

const fs = require("fs");
const config = require("../config");
const bybit = require("./bybit");
const signal = require("./signal");
const volatilityRegime = require("./volatilityRegime");

// Fase D1: config.maxHoldMinutes é o single source of truth entre backtest e
// live (lib/tradeLifecycle.js::isTimeStop usa o mesmo config ao vivo) --
// antes disso era uma constante local só daqui, e o bot ao vivo nunca
// implementava o equivalente (divergência de fidelidade backtest↔produção).
const intervalMinutes = Number(config.interval) || 1;
const MAX_HOLD_CANDLES = Math.max(1, Math.round(config.maxHoldMinutes / intervalMinutes));
const RANDOM_SAMPLES = 30;
const HISTORY_LIMIT = 15;

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}
function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function sampleParams(bounds) {
  let emaShort, emaLong;
  do {
    emaShort = randomInt(bounds.emaShort.min, bounds.emaShort.max);
    emaLong = randomInt(bounds.emaLong.min, bounds.emaLong.max);
  } while (emaShort >= emaLong);

  return {
    emaShort,
    emaLong,
    rsiPeriod: randomInt(bounds.rsiPeriod.min, bounds.rsiPeriod.max),
    stochOversold: randomInt(bounds.stochOversold.min, bounds.stochOversold.max),
    stochOverbought: randomInt(bounds.stochOverbought.min, bounds.stochOverbought.max),
    stopLossPct: Number(randomFloat(bounds.stopLossPct.min, bounds.stopLossPct.max).toFixed(4)),
  };
}

// ---- Indicadores vetorizados O(n) ----
// signal.analyze() é O(n²) (recalcula RSI numa janela crescente a cada chamada),
// o que é aceitável ao vivo (roda 1x a cada 10s) mas inviável aqui, onde cada
// combinação de parâmetros precisa varrer os ~1000 candles do backtest e isso
// se repete dezenas de vezes por execução do tuning.

function emaSeries(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(50);
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  if (period < closes.length) {
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function stochRsiSeries(rsi, period) {
  const out = new Array(rsi.length).fill(50);
  for (let i = period; i < rsi.length; i++) {
    const slice = rsi.slice(i - period + 1, i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    out[i] = max - min === 0 ? 50 : ((rsi[i] - min) / (max - min)) * 100;
  }
  return out;
}

function obvSeries(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prevClose = parseFloat(candles[i - 1][4]);
    const close = parseFloat(candles[i][4]);
    const volume = parseFloat(candles[i][5] || 0);
    out[i] = out[i - 1] + (close > prevClose ? volume : close < prevClose ? -volume : 0);
  }
  return out;
}

function buildSignals(candles, params) {
  const closes = candles.map((c) => parseFloat(c[4]));
  const emaShort = emaSeries(closes, params.emaShort);
  const emaLong = emaSeries(closes, params.emaLong);
  const rsi = rsiSeries(closes, params.rsiPeriod);
  const stoch = stochRsiSeries(rsi, params.rsiPeriod);
  const obv = obvSeries(candles);

  const signals = new Array(candles.length).fill("wait");
  const warmup = Math.max(params.emaLong, params.rsiPeriod * 2) + 1;

  for (let i = warmup; i < candles.length; i++) {
    const emaCrossBuy = emaShort[i] > emaLong[i];
    const emaCrossSell = emaShort[i] < emaLong[i];
    const stochBuy = stoch[i] < params.stochOversold;
    const stochSell = stoch[i] > params.stochOverbought;
    const rsiOkBuy = rsi[i] > 30 && rsi[i] < 50;
    const rsiOkSell = rsi[i] > 50 && rsi[i] < 70;
    const obvUp = obv[i] > 0;

    if (emaCrossBuy && stochBuy && rsiOkBuy && obvUp) signals[i] = "buy";
    else if (emaCrossSell && stochSell && rsiOkSell && !obvUp) signals[i] = "sell";
  }
  return signals;
}

/**
 * Simula trades usando os sinais gerados, checando stop-loss/take-profit
 * contra o high/low real de cada candle (não só o close). O alvo de preço é
 * derivado do mesmo raciocínio usado em lib/risk.js (TARGET_RETURN_PER_TRADE_PCT
 * é sobre a margem alocada, então em termos de variação de preço isso equivale
 * a target/leverageMax) — mantém o backtest consistente com o sizing real.
 */
function simulate(candles, params) {
  const signals = buildSignals(candles, params);
  const priceTargetPct = config.targetReturnPerTradePct / config.leverageMax;
  const rewardRiskRatio = priceTargetPct / params.stopLossPct;

  // Fase D2 (Circuit Breaker) -- mesmos 3 gatilhos de lib/risk.js, pra manter
  // o auto-tuning validando contra o que a produção realmente vai fazer.
  const regimeSeries = volatilityRegime.classifyVolatilitySeries(candles);
  const candleDurationMs = intervalMinutes * 60 * 1000;
  const pauseCandles = Math.max(1, Math.round(config.circuitBreakerPauseMs / candleDurationMs));
  let consecutiveLosses = 0;
  // Proxy de drawdown diário: soma cumulativa sem reset por dia -- o dataset
  // do backtest (1000 candles de 1min ≈ 16h) não costuma cruzar um limite de
  // dia, então não vale simular o reset ainda. Limitação conhecida, não
  // fabricada como precisão que não existe.
  let cumulativeLoss = 0;
  let pausedUntilIndex = -1;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let wins = 0,
    losses = 0,
    timeouts = 0;
  const tradeReturns = []; // variação fracionária do equity por trade (ex: 0.02 = +2%) — insumo do computeMetrics
  let i = 0;

  while (i < candles.length) {
    if (config.circuitBreakerOnHighVolatility && regimeSeries[i] === "HIGH") {
      pausedUntilIndex = Math.max(pausedUntilIndex, i + pauseCandles);
    }
    const blockedByCircuitBreaker = i < pausedUntilIndex;

    if (!blockedByCircuitBreaker && (signals[i] === "buy" || signals[i] === "sell")) {
      const isBuy = signals[i] === "buy";
      const entryPrice = parseFloat(candles[i][4]);
      const stopPrice = isBuy ? entryPrice * (1 - params.stopLossPct) : entryPrice * (1 + params.stopLossPct);
      const targetPrice = isBuy ? entryPrice * (1 + priceTargetPct) : entryPrice * (1 - priceTargetPct);

      let exitIndex = null;
      let outcome = "timeout";
      const lastIndex = Math.min(candles.length - 1, i + MAX_HOLD_CANDLES);
      for (let j = i + 1; j <= lastIndex; j++) {
        const high = parseFloat(candles[j][2]);
        const low = parseFloat(candles[j][3]);
        const hitStop = isBuy ? low <= stopPrice : high >= stopPrice;
        const hitTarget = isBuy ? high >= targetPrice : low <= targetPrice;
        // se os dois forem tocados no mesmo candle, assume o pior caso (stop primeiro)
        if (hitStop) {
          exitIndex = j;
          outcome = "stop";
          break;
        }
        if (hitTarget) {
          exitIndex = j;
          outcome = "target";
          break;
        }
      }

      const riskFraction = config.riskPerTradePct;
      let tradeReturn;
      if (outcome === "target") {
        tradeReturn = riskFraction * rewardRiskRatio;
        wins++;
      } else if (outcome === "stop") {
        tradeReturn = -riskFraction;
        losses++;
      } else {
        const exitPrice = parseFloat(candles[lastIndex][4]);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * (isBuy ? 1 : -1);
        tradeReturn = riskFraction * (pnlPct / params.stopLossPct);
        timeouts++;
      }
      equity *= 1 + tradeReturn;
      tradeReturns.push(tradeReturn);

      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);

      const tradeExitIndex = (exitIndex || lastIndex);

      // Mesma lógica de lib/risk.js::registerTradeResult -- loss streak e
      // drawdown acumulado (proxy do diário, ver nota acima) disparam a
      // mesma pausa que o gatilho de volatilidade já pode ter ativado.
      if (tradeReturn < 0) {
        consecutiveLosses++;
        cumulativeLoss += Math.abs(tradeReturn);
      } else {
        consecutiveLosses = 0;
      }
      if (consecutiveLosses >= config.circuitBreakerLossStreak || cumulativeLoss >= config.circuitBreakerDailyDrawdownPct) {
        pausedUntilIndex = Math.max(pausedUntilIndex, tradeExitIndex + pauseCandles);
        consecutiveLosses = 0;
      }

      i = tradeExitIndex + 1;
    } else {
      i++;
    }
  }

  const totalReturnPct = equity - 1;
  const totalTrades = wins + losses + timeouts;
  const score = totalReturnPct - 2 * maxDrawdown; // penaliza drawdown pra reduzir overfitting

  return { totalReturnPct, maxDrawdown, wins, losses, timeouts, totalTrades, score, tradeReturns };
}

/**
 * Métricas de desempenho padrão (Win Rate, Profit Factor, Expectância, Sharpe)
 * a partir da série de retornos por trade produzida por simulate(). Exigidas pela
 * disciplina de MVP: nenhuma fase nova deve ser promovida sem esse comparativo.
 */
function computeMetrics(tradeReturns, maxDrawdown = 0) {
  const totalTrades = tradeReturns.length;
  if (totalTrades === 0) {
    return { totalTrades: 0, winRate: 0, profitFactor: 0, expectancy: 0, sharpe: 0, maxDrawdown };
  }

  const gains = tradeReturns.filter((r) => r > 0);
  const losses = tradeReturns.filter((r) => r < 0);
  const grossGain = gains.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const winRate = gains.length / totalTrades;
  // Sem perdas, o profit factor tradicional é infinito — reportamos grossGain puro pra continuar comparável.
  const profitFactor = grossLoss > 0 ? grossGain / grossLoss : gains.length > 0 ? grossGain : 0;

  const mean = tradeReturns.reduce((a, b) => a + b, 0) / totalTrades;
  const variance = tradeReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / totalTrades;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? mean / stdev : 0;

  return { totalTrades, winRate, profitFactor, expectancy: mean, sharpe, maxDrawdown };
}

// Amostra mínima abaixo da qual uma comparação não é estatisticamente confiável —
// nesse caso o candidato nunca substitui o baseline, só fica registrado no histórico.
const MIN_TRADES_FOR_PROMOTION = 5;

/**
 * Decide se o candidato pode substituir o baseline em produção (tuning.json).
 * Implementa a regra do usuário: nenhuma mudança de parâmetros entra em produção
 * sem melhora estatística — expectância maior E drawdown não pior que uma
 * tolerância de 10% acima do baseline.
 */
function isCandidateBetter(baselineMetrics, candidateMetrics) {
  if (candidateMetrics.totalTrades < MIN_TRADES_FOR_PROMOTION) {
    return { promote: false, reason: "amostra insuficiente (" + candidateMetrics.totalTrades + " trades)" };
  }
  // Baseline sem histórico (ex: primeiro run do bot) — aceita o candidato como ponto de partida.
  if (baselineMetrics.totalTrades === 0) {
    return { promote: true, reason: "baseline sem histórico, usando candidato como ponto de partida" };
  }
  if (candidateMetrics.expectancy <= baselineMetrics.expectancy) {
    return { promote: false, reason: "expectância não melhorou" };
  }
  const drawdownTolerance = baselineMetrics.maxDrawdown * 1.1;
  if (candidateMetrics.maxDrawdown > drawdownTolerance) {
    return { promote: false, reason: "drawdown piorou além da tolerância" };
  }
  return { promote: true, reason: "expectância melhor com drawdown dentro da tolerância" };
}

/**
 * Roda o auto-tuning e só promove um novo conjunto de parâmetros a produção
 * (tuning.json `current`) se ele bater o baseline (parâmetros em produção hoje)
 * em expectância, sem piorar o drawdown além da tolerância — ver [[feedback-bot-cripto10-mvp-discipline]].
 * Se o candidato não passar no gate, o baseline é mantido e a comparação fica
 * registrada no histórico mesmo assim, pra dar visibilidade do que foi tentado.
 */
async function run() {
  const candles = await bybit.getKlines(config.symbol, config.interval, 1000);
  if (!candles || candles.length < 200) {
    throw new Error("Poucos candles retornados pela Bybit para rodar o backtest");
  }

  const currentParams = signal.loadParams();
  const baselineResult = simulate(candles, currentParams);
  const baselineMetrics = computeMetrics(baselineResult.tradeReturns, baselineResult.maxDrawdown);

  const candidates = [signal.DEFAULT_PARAMS];
  for (let k = 0; k < RANDOM_SAMPLES; k++) candidates.push(sampleParams(config.tuningBounds));

  let best = null;
  for (const params of candidates) {
    const result = simulate(candles, params);
    if (!best || result.score > best.score) {
      best = { params, ...result };
    }
  }
  const candidateMetrics = computeMetrics(best.tradeReturns, best.maxDrawdown);
  const decision = isCandidateBetter(baselineMetrics, candidateMetrics);

  let history = [];
  if (fs.existsSync(config.paths.tuningFile)) {
    try {
      history = JSON.parse(fs.readFileSync(config.paths.tuningFile, "utf8")).history || [];
    } catch (_) {
      /* arquivo corrompido — recomeça histórico */
    }
  }

  history.unshift({
    ranAt: new Date().toISOString(),
    candlesUsed: candles.length,
    promoted: decision.promote,
    reason: decision.reason,
    baseline: { params: currentParams, ...baselineMetrics },
    candidate: { params: best.params, ...candidateMetrics, score: best.score, totalReturnPct: best.totalReturnPct },
  });
  history = history.slice(0, HISTORY_LIMIT);

  const promotedParams = decision.promote
    ? { ...best.params, updatedAt: new Date().toISOString(), source: "backtest" }
    : currentParams;

  const output = {
    current: promotedParams,
    lastRun: {
      promoted: decision.promote,
      reason: decision.reason,
      baseline: baselineMetrics,
      candidate: { ...candidateMetrics, score: best.score, totalReturnPct: best.totalReturnPct },
    },
    history,
  };

  if (!fs.existsSync(config.paths.dataDir)) fs.mkdirSync(config.paths.dataDir, { recursive: true });
  fs.writeFileSync(config.paths.tuningFile, JSON.stringify(output, null, 2));

  return output;
}

module.exports = { run, simulate, sampleParams, buildSignals, computeMetrics, isCandidateBetter, MAX_HOLD_CANDLES };

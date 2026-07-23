const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../config");
const bybit = require("./bybit");
const signal = require("./signal");
const volatilityRegime = require("./volatilityRegime");
const candleHistory = require("./candleHistory");
const indicators = require("./indicators");
const { DEFAULT_DB_PATH } = require("./infra/db");

const MIN_CANDLES_FOR_BACKTEST = 200;

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

// emaSeries foi promovida pra lib/indicators.js::calcEMASeries (Market Brain
// também precisa da série inteira, não só o backtest) -- mesma fórmula,
// import em vez de definição local, sem mudar nenhum comportamento aqui.
const emaSeries = indicators.calcEMASeries;

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
 * Simula trades usando os sinais gerados, checando stop-loss/break-even/
 * trailing/TP escalonado contra o high/low real de cada candle (não só o
 * close) -- mesma mecânica de saída da Fase D usada ao vivo (index.js):
 * stop original -> break even em +1R (D3) -> trailing ATR adaptativo (D4)
 * -> níveis de TP parcial em config.tpLevels fecham fração da posição
 * antecipadamente (D5), o resto corre no break even/trailing. Não existe
 * mais um alvo fixo único (config.targetReturnPerTradePct não influencia
 * esta simulação).
 */
// Fase D4 -- mesma tabela de config usada ao vivo (index.js), regime em
// minúsculo pra bater com as chaves de config.trailingStopAtrMultiplier.
function trailingMultiplierFor(regime) {
  const table = config.trailingStopAtrMultiplier;
  return table[String(regime).toLowerCase()] ?? table.normal;
}

function simulate(candles, params) {
  const signals = buildSignals(candles, params);

  // Fase D2 (Circuit Breaker) -- mesmos 3 gatilhos de lib/risk.js, pra manter
  // o auto-tuning validando contra o que a produção realmente vai fazer.
  const regimeSeries = volatilityRegime.classifyVolatilitySeries(candles);
  // Fase D4 -- mesmo período (14) e fonte que analysis.atr ao vivo (lib/signal.js).
  const atrSeriesForSimulation = volatilityRegime.atrSeries(candles, volatilityRegime.DEFAULT_PERIOD);
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
    breakevens = 0; // Fase D3 -- saída no zero a zero depois do stop mover pra entrada
  const riskFraction = config.riskPerTradePct;
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
      const riskUnit = Math.abs(entryPrice - stopPrice); // R -- Fase D3 (break even) e D5 (níveis de TP)

      // Fase D5 -- níveis de TP escalonado deste trade, preço absoluto a
      // partir de R. O que sobrar depois dos níveis (1 - soma dos qtyPct)
      // roda no break even/trailing (D3/D4) -- substitui o antigo alvo
      // fixo único (config.targetReturnPerTradePct não é mais usado aqui).
      const tpLevelsForTrade = (config.tpLevels || []).map((level) => ({
        r: level.r,
        qtyPct: level.qtyPct,
        price: isBuy ? entryPrice + riskUnit * level.r : entryPrice - riskUnit * level.r,
        filled: false,
      }));

      let exitIndex = null;
      let exitStopPrice = null; // preço real do stop no momento do hit -- pode ser o original, a entrada (breakeven) ou um nível ratcheado pelo trailing (D4)
      let breakEvenActive = false;
      let effectiveStop = stopPrice;
      // Fase D4 (Trailing ATR adaptativo): só ativa depois do break even (D3),
      // usando o mesmo gatilho de +1R como base, mas com sua própria distância
      // -- ver comentário em applyTrailingStop (index.js) sobre por que
      // activePrice é escolhido pra nunca deixar o piso do trailing pior que
      // a entrada.
      let trailingActive = false;
      let trailingDistance = null;
      let trailingStopLevel = null;
      let bestFavorable = entryPrice;
      let remaining = 1; // fração da posição ainda não fechada por TP parcial
      let realizedReturn = 0; // soma ponderada das pernas de TP já fechadas
      let fullyClosedByTp = false;
      const lastIndex = Math.min(candles.length - 1, i + MAX_HOLD_CANDLES);
      for (let j = i + 1; j <= lastIndex; j++) {
        const high = parseFloat(candles[j][2]);
        const low = parseFloat(candles[j][3]);

        if (isBuy) bestFavorable = Math.max(bestFavorable, high);
        else bestFavorable = Math.min(bestFavorable, low);

        const currentStop = trailingActive ? trailingStopLevel : effectiveStop;
        const hitStop = isBuy ? low <= currentStop : high >= currentStop;
        // se stop e TP forem tocados no mesmo candle, assume o pior caso (stop primeiro)
        if (hitStop) {
          exitIndex = j;
          exitStopPrice = currentStop;
          break;
        }

        for (const level of tpLevelsForTrade) {
          if (level.filled) continue;
          const reached = isBuy ? high >= level.price : low <= level.price;
          if (reached) {
            level.filled = true;
            realizedReturn += riskFraction * level.r * level.qtyPct;
            remaining -= level.qtyPct;
          }
        }
        if (remaining <= 1e-9) {
          fullyClosedByTp = true;
          exitIndex = j;
          break;
        }

        // Break even/trailing avaliados DEPOIS da checagem de stop/TP deste
        // candle -- só passam a valer a partir do próximo (mesma convenção
        // pessimista: nunca assume a ordem mais favorável dentro de um candle
        // sem dado intracandle real).
        if (!breakEvenActive) {
          const favorableExtreme = isBuy ? high : low;
          const reachedBreakEven = isBuy ? favorableExtreme - entryPrice >= riskUnit : entryPrice - favorableExtreme >= riskUnit;
          if (reachedBreakEven) {
            breakEvenActive = true;
            effectiveStop = entryPrice;
          }
        } else if (!trailingActive) {
          const regimeAtJ = regimeSeries[j];
          const multiplier = trailingMultiplierFor(regimeAtJ);
          const distance = atrSeriesForSimulation[j] * multiplier;
          if (distance > 0) {
            const activePrice = isBuy ? entryPrice + distance : entryPrice - distance;
            const reachedActivation = isBuy ? high >= activePrice : low <= activePrice;
            if (reachedActivation) {
              trailingActive = true;
              trailingDistance = distance;
              // Piso na ativação = exatamente a entrada, por construção
              // (activePrice - distance), nunca pior que o break even.
              trailingStopLevel = isBuy ? activePrice - distance : activePrice + distance;
            }
          }
        } else {
          // Trailing já ativo -- ratcheia com base no melhor preço alcançado, nunca frouxa.
          const candidate = isBuy ? bestFavorable - trailingDistance : bestFavorable + trailingDistance;
          trailingStopLevel = isBuy ? Math.max(trailingStopLevel, candidate) : Math.min(trailingStopLevel, candidate);
        }
      }

      // Fase D5 -- retorno final compõe as pernas de TP já realizadas com o
      // que sobrou (fechado por stop/breakeven/trailing ou timeout), em vez
      // de um resultado categórico único. Classificação de wins/losses/
      // breakevens agora é pelo SINAL do retorno final do trade como um
      // todo, não por "qual mecanismo disparou" (um trade pode ter uma
      // perna de TP lucrativa e o resto fechar em perda, por exemplo).
      let tradeReturn;
      if (fullyClosedByTp) {
        tradeReturn = realizedReturn;
      } else if (exitStopPrice !== null) {
        const pnlPct = ((exitStopPrice - entryPrice) / entryPrice) * (isBuy ? 1 : -1);
        tradeReturn = realizedReturn + riskFraction * (pnlPct / params.stopLossPct) * remaining;
      } else {
        const exitPrice = parseFloat(candles[lastIndex][4]);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * (isBuy ? 1 : -1);
        tradeReturn = realizedReturn + riskFraction * (pnlPct / params.stopLossPct) * remaining;
      }
      if (tradeReturn > 0) wins++;
      else if (tradeReturn === 0) breakevens++;
      else losses++;
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
  const totalTrades = wins + losses + breakevens;
  const score = totalReturnPct - 2 * maxDrawdown; // penaliza drawdown pra reduzir overfitting

  return { totalReturnPct, maxDrawdown, wins, losses, breakevens, totalTrades, score, tradeReturns };
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
function openReadOnlyDb(dbPath) {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null; // banco ainda não existe/inacessível -- cai pro fallback ao vivo
  }
}

// Prefere candles já persistidos em data/market.db (item 1 do sequenciamento
// de Brains -- sem isso nenhum Brain novo tem amostra estatística robusta
// pra validar). Cai pro comportamento antigo (busca ao vivo na Bybit) quando
// o banco não existe ainda ou não tem trecho contíguo suficiente -- nunca
// regride o que já funciona em produção hoje. `db`/`bybitClient` injetáveis
// só pra teste (produção sempre usa os defaults reais).
async function resolveCandles({ db, bybitClient }) {
  const ownDb = !db;
  const activeDb = db || openReadOnlyDb(DEFAULT_DB_PATH);

  if (activeDb) {
    try {
      const result = candleHistory.getBacktestCandles(activeDb, {
        symbol: config.symbol,
        interval: config.interval,
        intervalMinutes,
        lookbackDays: config.backtestDbLookbackDays,
        minCandles: MIN_CANDLES_FOR_BACKTEST,
      });
      if (result) {
        return {
          candles: result.candles,
          candleSource: "market_db",
          candleCount: result.candles.length,
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
        };
      }
    } finally {
      if (ownDb) activeDb.close();
    }
  }

  const liveCandles = await bybitClient.getKlines(config.symbol, config.interval, 1000);
  if (!liveCandles || liveCandles.length < MIN_CANDLES_FOR_BACKTEST) {
    throw new Error("Poucos candles retornados pela Bybit para rodar o backtest");
  }
  return {
    candles: liveCandles,
    candleSource: "live_fallback",
    candleCount: liveCandles.length,
    windowStart: liveCandles[0][0],
    windowEnd: liveCandles[liveCandles.length - 1][0],
  };
}

async function run({ db, bybitClient = bybit } = {}) {
  const { candles, candleSource, candleCount, windowStart, windowEnd } = await resolveCandles({ db, bybitClient });

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
    candleSource,
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
      candleSource,
      candleCount,
      windowStart,
      windowEnd,
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

const config = require("../config");

function decimalsOf(stepStr) {
  const idx = stepStr.indexOf(".");
  return idx === -1 ? 0 : stepStr.length - idx - 1;
}

// Arredonda pra baixo (nunca excede o qty calculado pelo risco) respeitando o qtyStep do símbolo.
function roundQtyDown(qty, qtyStepStr) {
  const step = parseFloat(qtyStepStr);
  const rounded = Math.floor(qty / step) * step;
  return Number(rounded.toFixed(decimalsOf(qtyStepStr)));
}

// Arredonda pro tick mais próximo, respeitando o tickSize do símbolo.
function roundToTick(price, tickSizeStr) {
  const tick = parseFloat(tickSizeStr);
  const rounded = Math.round(price / tick) * tick;
  return Number(rounded.toFixed(decimalsOf(tickSizeStr)));
}

/**
 * Decide se um novo trade pode ser aberto agora.
 * state: objeto de lib/state.js (já reconciliado com a posição real)
 */
function canExecute(signal, state) {
  const now = Date.now();

  if (now - state.lastTradeTime < config.cooldownMs) {
    return { ok: false, reason: "cooldown" };
  }

  if (signal === "buy" && state.isOpened) {
    return { ok: false, reason: "already_open" };
  }
  if (signal === "sell" && state.isOpened && state.side === "Sell") {
    return { ok: false, reason: "already_open" };
  }

  if (state.dailyLoss >= config.dailyLossLimitPct) {
    return { ok: false, reason: "daily_loss_limit_reached" };
  }

  if (state.circuitBreakerUntil && now < state.circuitBreakerUntil) {
    return { ok: false, reason: "circuit_breaker" };
  }

  return { ok: true };
}

/**
 * Calcula tamanho da posição, stop-loss e take-profit.
 *
 * Sizing: arrisca RISK_PER_TRADE_PCT do equity real por trade (distância até o
 * stop-loss definida por stopLossPct do sinal, com fallback pro ATR quando
 * disponível). O resultado é limitado por LEVERAGE_MAX para nunca alocar mais
 * margem do que o teto de alavancagem configurado.
 *
 * Take-profit: alvo de TARGET_RETURN_PER_TRADE_PCT sobre a MARGEM alocada
 * (não sobre o valor nocional) — é isso que torna "6% por trade" alcançável
 * com alavancagem, mas o tamanho do stop-loss é que garante que a perda
 * máxima por trade fique dentro do RISK_PER_TRADE_PCT do equity, independente
 * da alavancagem usada.
 */
function planOrder({ side, price, atr, equity, params, instrumentInfo }) {
  const stopDistanceByPct = price * params.stopLossPct;
  const stopDistance = atr && atr > 0 ? Math.max(atr, stopDistanceByPct) : stopDistanceByPct;

  const riskAmount = equity * config.riskPerTradePct;
  let qty = riskAmount / stopDistance;

  // Limita pelo teto de alavancagem: notional = qty * price não pode exceder equity * leverageMax
  const maxNotional = equity * config.leverageMax;
  const notional = qty * price;
  if (notional > maxNotional) {
    qty = maxNotional / price;
  }

  const marginUsed = (qty * price) / config.leverageMax;
  const desiredProfit = marginUsed * config.targetReturnPerTradePct;
  const priceMoveForTarget = qty > 0 ? desiredProfit / qty : 0;

  const isBuy = side === "buy" || side === "Buy";
  const stopLossPrice = isBuy ? price - stopDistance : price + stopDistance;
  const takeProfitPrice = isBuy ? price + priceMoveForTarget : price - priceMoveForTarget;

  return {
    qty: instrumentInfo ? roundQtyDown(qty, instrumentInfo.qtyStep) : Number(qty.toFixed(6)),
    stopLossPrice: instrumentInfo ? roundToTick(stopLossPrice, instrumentInfo.tickSize) : Number(stopLossPrice.toFixed(4)),
    takeProfitPrice: instrumentInfo ? roundToTick(takeProfitPrice, instrumentInfo.tickSize) : Number(takeProfitPrice.toFixed(4)),
    marginUsed,
    riskAmount,
  };
}

/**
 * Ativa a pausa do circuit breaker (Fase D2) por config.circuitBreakerPauseMs
 * a partir de `now`, e zera a sequência de perdas -- o próximo streak só
 * volta a contar depois que a pausa acabar.
 */
function triggerCircuitBreaker(state, now) {
  state.circuitBreakerUntil = now + config.circuitBreakerPauseMs;
  state.consecutiveLosses = 0;
}

/**
 * Atualiza o acumulado de perda diária e a sequência de perdas consecutivas
 * (circuit breaker). pnlPct é a variação percentual do equity causada pelo
 * trade (negativo = perda). Dispara a pausa se a sequência de perdas ou o
 * drawdown diário baterem seus limiares configurados -- gatilho de
 * volatilidade extrema é separado, ver registerVolatilityCheck (é observado
 * por ciclo, não por trade fechado).
 */
function registerTradeResult(state, pnlPct) {
  const now = Date.now();
  if (pnlPct < 0) {
    state.dailyLoss += Math.abs(pnlPct);
    state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
  } else {
    state.consecutiveLosses = 0;
  }
  state.lastTradeTime = now;

  const streakHit = state.consecutiveLosses >= config.circuitBreakerLossStreak;
  const drawdownHit = state.dailyLoss >= config.circuitBreakerDailyDrawdownPct;
  if (streakHit || drawdownHit) {
    triggerCircuitBreaker(state, now);
  }
  return state;
}

/**
 * Terceiro gatilho do circuit breaker (Fase D2): volatilidade extrema
 * observada nos candles do ciclo atual (lib/volatilityRegime.js), não
 * associada a um trade fechado. Chamado a cada ciclo em index.js -- enquanto
 * o regime continuar HIGH, a pausa é reestendida (rolling), então a contagem
 * regressiva de config.circuitBreakerPauseMs só começa depois que a
 * volatilidade normalizar.
 */
function registerVolatilityCheck(state, regime, now = Date.now()) {
  if (config.circuitBreakerOnHighVolatility && regime === "HIGH") {
    triggerCircuitBreaker(state, now);
  }
  return state;
}

module.exports = { canExecute, planOrder, registerTradeResult, registerVolatilityCheck };

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
 * Atualiza o acumulado de perda diária (circuit breaker). pnlPct é a variação
 * percentual do equity causada pelo trade (negativo = perda).
 */
function registerTradeResult(state, pnlPct) {
  if (pnlPct < 0) {
    state.dailyLoss += Math.abs(pnlPct);
  }
  state.lastTradeTime = Date.now();
  return state;
}

module.exports = { canExecute, planOrder, registerTradeResult };

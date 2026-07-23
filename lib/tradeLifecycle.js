// Trade Lifecycle Engine -- ponto único de decisão sobre saídas que o bot
// decide e executa ativamente (ao contrário de SL/TP, que a Bybit executa
// no servidor e o bot só descobre via reconciliação). Existe pra evitar que
// cada saída nova (time stop, break even, trailing, TP parcial...) vire mais
// um `if` espalhado em index.js::cycle().
const REASONS = {
  TIME_STOP: "time_stop",
  SIGNAL_REVERSAL: "signal_reversal",
};

function isTimeStop(botState, config, now) {
  if (!botState.isOpened || !botState.openedAt) return false;
  const maxHoldMs = config.maxHoldMinutes * 60 * 1000;
  return now - botState.openedAt >= maxHoldMs;
}

function isSignalReversal(botState, analysis) {
  if (!botState.isOpened) return false;
  return (
    (botState.side === "Buy" && analysis.signal === "sell") ||
    (botState.side === "Sell" && analysis.signal === "buy")
  );
}

/**
 * Fase D3 (Break Even): true quando o preço já andou +1R a favor da posição
 * (R = distância do stop-loss original até a entrada) e o break even ainda
 * não foi aplicado nesta posição. Diferente de evaluate() -- não fecha a
 * posição, só sinaliza que o stop deve ser movido pra entrada (risco zero).
 */
function isBreakEvenDue(botState, analysis) {
  if (!botState.isOpened || botState.breakEvenApplied) return false;
  if (botState.stopLossPrice == null || botState.entryPrice == null) return false;
  const riskUnit = Math.abs(botState.entryPrice - botState.stopLossPrice);
  if (riskUnit <= 0) return false;
  const favorableMove =
    botState.side === "Buy" ? analysis.price - botState.entryPrice : botState.entryPrice - analysis.price;
  return favorableMove >= riskUnit;
}

/**
 * Fase D4 (Trailing ATR adaptativo): preço a partir do qual o trailing
 * ativa, escolhido de propósito pra que o piso do trailing nesse momento
 * (activePrice - distance) seja exatamente a entrada -- nunca pior que o
 * break even (D3) já aplicado.
 */
function computeTrailingActivePrice(botState, distance) {
  return botState.side === "Buy" ? botState.entryPrice + distance : botState.entryPrice - distance;
}

/**
 * True quando o trailing deve ativar: só depois do break even já aplicado
 * (D3 é pré-requisito, não uma alternativa), ainda não ativado nesta
 * posição, e o preço já alcançou o activePrice calculado acima.
 */
function isTrailingActivationDue(botState, analysis, distance) {
  if (!botState.isOpened || !botState.breakEvenApplied || botState.trailingActivated) return false;
  if (botState.entryPrice == null || !distance || distance <= 0) return false;
  const activePrice = computeTrailingActivePrice(botState, distance);
  return botState.side === "Buy" ? analysis.price >= activePrice : analysis.price <= activePrice;
}

/**
 * Avalia se a posição atual deve ser fechada agora. Ordem importa: time
 * stop é checado antes de reversão de sinal porque é uma regra de risco
 * (tempo demais exposto), não uma leitura de mercado -- deve vencer mesmo
 * que o sinal ainda não tenha revertido.
 */
function evaluate({ botState, analysis, now = Date.now(), config }) {
  if (!botState.isOpened) return { reason: null };
  if (isTimeStop(botState, config, now)) return { reason: REASONS.TIME_STOP };
  if (isSignalReversal(botState, analysis)) return { reason: REASONS.SIGNAL_REVERSAL };
  return { reason: null };
}

module.exports = {
  evaluate,
  isTimeStop,
  isSignalReversal,
  isBreakEvenDue,
  isTrailingActivationDue,
  computeTrailingActivePrice,
  REASONS,
};

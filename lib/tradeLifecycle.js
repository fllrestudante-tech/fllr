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

module.exports = { evaluate, isTimeStop, isSignalReversal, REASONS };

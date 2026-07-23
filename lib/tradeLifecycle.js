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

// Motivos possíveis de um fechamento que a Bybit executa no servidor (o bot
// só descobre depois via reconciliação) -- diferente de REASONS acima, que
// são saídas que o próprio bot decide e executa.
const EXTERNAL_CLOSE_REASONS = {
  TRAILING_STOP: "trailing_stop",
  BREAK_EVEN: "break_even",
  TAKE_PROFIT: "take_profit",
  STOP_LOSS: "stop_loss",
  UNKNOWN: "external_close_unknown", // estado antigo/corrompido sem stopLossPrice/takeProfitPrice -- não adivinha
};

/**
 * Classifica por que uma posição sumiu na Bybit sem o bot ter mandado
 * fechar. Ordem importa: se o trailing já estava ativo, o stop vigente no
 * servidor era o dele (mais confiável que comparar preços); se só o break
 * even foi aplicado, o stop vigente era a entrada; caso nenhum dos dois,
 * compara o preço de saída real contra os dois níveis que o próprio bot
 * definiu na abertura (stopLossPrice/takeProfitPrice) -- não é um palpite,
 * é identificar qual dos dois limiares conhecidos foi de fato tocado.
 */
function classifyExternalClose(botState, exitPrice) {
  if (botState.trailingActivated) return EXTERNAL_CLOSE_REASONS.TRAILING_STOP;
  if (botState.breakEvenApplied) return EXTERNAL_CLOSE_REASONS.BREAK_EVEN;
  if (botState.stopLossPrice == null || botState.takeProfitPrice == null || exitPrice == null) {
    return EXTERNAL_CLOSE_REASONS.UNKNOWN;
  }
  const distToStop = Math.abs(exitPrice - botState.stopLossPrice);
  const distToTarget = Math.abs(exitPrice - botState.takeProfitPrice);
  return distToTarget <= distToStop ? EXTERNAL_CLOSE_REASONS.TAKE_PROFIT : EXTERNAL_CLOSE_REASONS.STOP_LOSS;
}

/**
 * Fase D5: qual nível de TP escalonado disparou. Não precisa comparar preço
 * (diferente de classifyExternalClose) -- os níveis são registrados em
 * ordem (TP1 antes de TP2) e botState.tpLevelsFilled já sabe quantos
 * dispararam até agora, então o próximo a faltar é sempre o próximo índice.
 * Retorna null se todos os níveis conhecidos já foram consumidos (não
 * deveria acontecer com a config atual de 2 níveis, mas não adivinha).
 */
function classifyPartialClose(botState) {
  const levels = botState.tpLevels || [];
  const nextIndex = botState.tpLevelsFilled || 0;
  if (nextIndex >= levels.length) return null;
  return `tp${nextIndex + 1}`;
}

module.exports = {
  evaluate,
  isTimeStop,
  isSignalReversal,
  isBreakEvenDue,
  isTrailingActivationDue,
  computeTrailingActivePrice,
  classifyExternalClose,
  classifyPartialClose,
  REASONS,
  EXTERNAL_CLOSE_REASONS,
};

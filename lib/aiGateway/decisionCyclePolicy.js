// AI Decision Cycle: decide, por ciclo do loop de trading (10s), se vale a
// pena pagar uma chamada de IA agora. Existe pra não martelar OpenAI/
// Anthropic a cada tick -- só chama quando há sinal quantitativo de verdade
// (buy/sell) ou quando o heartbeat máximo expirou (garante alguma leitura
// periódica mesmo em mercado parado, pra não deixar a auditoria/reconciliação
// "cega" por horas), sempre respeitando um piso mínimo entre chamadas
// (config.ai.minCallIntervalMs) e um cost-guard por hash de contexto (não
// paga de novo pelo mesmo contexto fora do heartbeat). Puro, sem I/O --
// index.js é quem lê/grava botState.lastAiCallAt/lastAiContextHash.
function shouldCallAi({ analysis, botState, contextHash, config, now = Date.now() }) {
  const lastCallAt = botState.lastAiCallAt || 0;
  const elapsedSinceLastCall = now - lastCallAt;

  if (elapsedSinceLastCall < config.ai.minCallIntervalMs) {
    return { call: false, reason: "min_interval_not_elapsed" };
  }

  const hasQuantSignal = analysis.signal === "buy" || analysis.signal === "sell";
  const heartbeatDue = elapsedSinceLastCall >= config.ai.shadowIntervalMs;

  if (!hasQuantSignal && !heartbeatDue) {
    return { call: false, reason: "no_relevant_context" };
  }

  if (contextHash && contextHash === botState.lastAiContextHash && !heartbeatDue) {
    return { call: false, reason: "context_unchanged" };
  }

  return { call: true, reason: hasQuantSignal ? "quant_signal" : "heartbeat" };
}

module.exports = { shouldCallAi };

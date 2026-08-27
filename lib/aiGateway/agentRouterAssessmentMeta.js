// Construção PURA de assessmentMeta -- Fase 10 / Commit 4c2. Extraído de
// index.js (correção de revisão do usuário, 2026-08-25: o wiring que liga
// candles + decision.reason + config.interval é a fronteira mais
// importante do 4c2 e precisa de teste direto, não inspeção/grep --
// importar index.js pra testar teria efeito colateral, então esta função
// mora num módulo próprio, testável sem nenhuma dependência de index.js).
//
// Só constrói o que index.js EXCLUSIVAMENTE possui: triggerReason
// (decisionCyclePolicy.js) e lastClosedCandleTimestampMs (via
// selectLastClosedCandleTimestampMs, helper puro do Commit 4c1). NUNCA
// calcula taskClass/quantFingerprint/assessmentKey/attemptId -- isso
// acontece dentro de lib/aiGateway/aiGateway.js (agentRouterGate.js),
// deliberadamente, pra que uma falha nesse cálculo ainda produza um
// providerAttempts[] auditável em vez de nunca chegar a chamar
// getAssessment() (ver plano do 4c2).
//
// Com `enabled=false`: devolve `undefined` SEM chamar
// selectLastClosedCandleTimestampMs -- helper de candle e fingerprint
// nunca executam com a flag desligada (prova por instrumentação nos
// testes, não só inspeção).
const { selectLastClosedCandleTimestampMs } = require("./contextSnapshot");

/**
 * `nowFn` chamado NO MÁXIMO uma vez por chamada (única leitura de "agora"
 * reutilizada na seleção do candle) -- nunca uma segunda leitura
 * independente que pudesse atravessar a fronteira de um candle dentro da
 * mesma avaliação. Candle inválido (interval desconhecido, série fora de
 * ordem, nenhum candle fechado, etc.) NUNCA lança aqui --
 * selectLastClosedCandleTimestampMs já é fail-closed (devolve `null`,
 * Commit 4c1); esse `null` vira metadado inválido, tratado como fatal
 * DENTRO de getAssessment() (agentRouterGate.js), nunca antes dele.
 */
function buildAgentRouterAssessmentMeta({ enabled, triggerReason, candles, interval, nowFn = Date.now }) {
  if (!enabled) return undefined;
  const nowMs = nowFn();
  return {
    triggerReason,
    lastClosedCandleTimestampMs: selectLastClosedCandleTimestampMs(candles, interval, nowMs),
  };
}

module.exports = { buildAgentRouterAssessmentMeta };

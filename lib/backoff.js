/**
 * Delay do próximo ciclo do loop principal (index.js). Em operação normal
 * (sem falha), mantém o intervalo configurado. Falhas consecutivas (ex: outage
 * de rede) crescem o delay exponencialmente até maxMs, para não martelar a
 * Bybit a cada 10s fixos durante uma instabilidade prolongada. Reseta para
 * baseMs assim que um ciclo tiver sucesso (consecutiveFailures volta a 0).
 */
function nextLoopDelay(consecutiveFailures, baseMs, maxMs) {
  if (consecutiveFailures <= 0) return baseMs;
  const delay = baseMs * 2 ** consecutiveFailures;
  return Math.min(delay, maxMs);
}

module.exports = { nextLoopDelay };

// Exit Analytics -- responde "de onde vem o lucro de verdade" agrupando os
// mesmos trades fechados que lib/tradingHealth.js já usa (não duplica
// leitura de arquivo, recebe a lista já extraída). Read-only, não influencia
// nenhuma decisão de trading -- mesmo espírito do Trading Health.
const UNKNOWN_REASON = "desconhecido"; // trades fechados antes do campo `reason` existir nos logs (Fase D) -- não adivinha o motivo

/**
 * trades: lista de eventos já filtrados por lib/tradingHealth.js::extractClosedTrades
 * (cada um com pnlPct numérico; `reason` pode faltar em dados antigos).
 */
function computeExitAnalytics(trades) {
  const byReason = {};
  for (const t of trades) {
    const reason = t.reason || UNKNOWN_REASON;
    if (!byReason[reason]) byReason[reason] = { trades: 0, wins: 0, totalPnlPct: 0 };
    const bucket = byReason[reason];
    bucket.trades += 1;
    if (t.pnlPct > 0) bucket.wins += 1;
    bucket.totalPnlPct += t.pnlPct;
  }

  const summary = {};
  for (const [reason, bucket] of Object.entries(byReason)) {
    summary[reason] = {
      trades: bucket.trades,
      winRate: bucket.wins / bucket.trades,
      totalPnlPct: bucket.totalPnlPct,
      avgPnlPct: bucket.totalPnlPct / bucket.trades,
    };
  }
  return summary;
}

module.exports = { computeExitAnalytics, UNKNOWN_REASON };

// Formatação pura do painel operacional (scripts/health.js consome isso) --
// nenhum fs aqui, só transforma o conteúdo já lido de runtime/metrics/*.json
// em linhas de texto. Testável sem tocar disco.
function fmtPct(n, digits = 0) {
  return typeof n === "number" ? `${n.toFixed(digits)}%` : "—";
}
function fmtMs(ms) {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}
function fmtMb(bytes) {
  return typeof bytes === "number" ? `${(bytes / 1048576).toFixed(1)}MB` : "—";
}
function fmtRatePerHour(perMin) {
  return typeof perMin === "number" ? `${(perMin * 60).toFixed(1)}/h` : "—";
}
function fmtUptime(startedAt, now = Date.now()) {
  if (!startedAt) return "—";
  const ms = now - new Date(startedAt).getTime();
  if (ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

function padRow(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join("  ");
}

/**
 * Uma linha por domínio (candles/funding/fear_greed/...) -- é onde
 * Freshness/SLA/Throughput/Rows-hour fazem sentido (não no nível do
 * processo, que agrupa vários domínios como o Bybit Collector).
 */
function formatDomainsTable(collectorsSnapshot) {
  if (!collectorsSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];

  const rows = [];
  for (const [collectorName, c] of Object.entries(collectorsSnapshot.collectors || {})) {
    for (const [domain, d] of Object.entries(c.domains || {})) {
      rows.push([
        domain,
        collectorName,
        d.freshness ? `${d.freshness.score}% (${d.freshness.state})` : "—",
        d.lastSuccessAt ? new Date(d.lastSuccessAt).toISOString() : "nunca",
        fmtRatePerHour(d.insertedPerMin),
        d.totalErrors ?? 0,
        d.apiHealth?.score != null ? fmtPct(d.apiHealth.score, 1) : "—",
      ]);
    }
  }
  if (rows.length === 0) return ["  (nenhum domínio com dado ainda)"];

  const header = ["Domínio", "Coletor", "Freshness", "Última coleta (UTC)", "Rows/hour", "Erros", "API Health"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];
}

/**
 * Uma linha por processo supervisionado (+ telegram_radar, manual) --
 * Uptime/Restarts/CPU/RAM/Estado operacional (modelo de 7 estados).
 */
function formatProcessesTable(processesSnapshot, now = Date.now()) {
  if (!processesSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];

  const rows = Object.entries(processesSnapshot.processes || {}).map(([name, p]) => [
    name,
    p.degraded ? `${p.operationalState} (degraded)` : p.operationalState,
    fmtUptime(p.startedAt, now),
    p.totalRestarts ?? 0,
    p.cpuPercent != null ? fmtPct(p.cpuPercent) : "—",
    p.ramBytes != null ? fmtMb(p.ramBytes) : "—",
  ]);
  if (rows.length === 0) return ["  (nenhum processo registrado ainda)"];

  const header = ["Processo", "Estado", "Uptime", "Restarts", "CPU", "RAM"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];
}

function formatDatabaseSection(databaseSnapshot) {
  if (!databaseSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  const lines = [
    `  Tamanho: ${fmtMb(databaseSnapshot.sizeBytes)} | Fragmentação: ${databaseSnapshot.fragmentationRatio != null ? fmtPct(databaseSnapshot.fragmentationRatio * 100, 1) : "—"} | VACUUM necessário: ${databaseSnapshot.vacuumNeeded ? "SIM" : "não"}`,
    `  Integridade: ${databaseSnapshot.integrity ? (databaseSnapshot.integrity.ok ? "ok" : `FALHOU (${databaseSnapshot.integrity.detail})`) : "não checado nesta amostra"}`,
    `  INSERT/s (derivado do throughput por domínio): ${databaseSnapshot.insertedPerSec != null ? databaseSnapshot.insertedPerSec.toFixed(3) : "—"}`,
    `  SELECT/s: não rastreado (${databaseSnapshot.selectPerSec?.reason || "workload majoritariamente escrita"})`,
  ];
  return lines;
}

function formatTradingSection(tradingSnapshot) {
  if (!tradingSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  if (tradingSnapshot.totalTrades === 0) return ["  (nenhum trade fechado registrado ainda)"];

  const pa = tradingSnapshot.portfolioAnalytics || {};
  return [
    `  Trades: ${tradingSnapshot.totalTrades} | Win Rate: ${fmtPct(tradingSnapshot.winRate * 100, 1)} | Profit Factor: ${tradingSnapshot.profitFactor.toFixed(2)} | Expectância: ${fmtPct(tradingSnapshot.expectancy * 100, 3)}`,
    `  Drawdown máx: ${fmtPct(tradingSnapshot.maxDrawdown * 100, 2)} | Sharpe: ${tradingSnapshot.sharpe.toFixed(2)} | Sortino: ${typeof pa.sortino === "number" ? pa.sortino.toFixed(2) : "—"} | Recovery Factor: ${pa.recoveryFactor != null ? pa.recoveryFactor.toFixed(2) : "—"}`,
    `  Kelly Fraction: ${pa.kellyFraction != null ? pa.kellyFraction.toFixed(3) : "—"} | VaR(${pa.confidence ?? "?"}): ${pa.var != null ? fmtPct(pa.var * 100, 2) : "—"} | CVaR: ${pa.cvar != null ? fmtPct(pa.cvar * 100, 2) : "—"}`,
    `  Hold time médio: ${fmtMs(tradingSnapshot.averageHoldMs)} (${tradingSnapshot.tradesWithHoldData}/${tradingSnapshot.totalTrades} trades com esse dado)`,
  ];
}

module.exports = {
  formatDomainsTable,
  formatProcessesTable,
  formatDatabaseSection,
  formatTradingSection,
  fmtPct,
  fmtMs,
  fmtMb,
  fmtRatePerHour,
  fmtUptime,
};

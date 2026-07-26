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

// 3x o intervalo de amostragem do metrics_sampler (SAMPLE_INTERVAL_MS=60s em
// scripts/metricsSampler.js) -- mesmo raciocínio de SUPERVISOR_STALE_MS em
// lib/healthChecks.js. Achado real (2026-07-21): quando o supervisor e todos
// os filhos (inclusive o próprio metrics_sampler) morrem juntos, ninguém
// mais atualiza processes.json -- a tabela ficava mostrando "RUNNING" com
// uptime crescente por HORAS depois da morte real, porque só reproduzia o
// último snapshot congelado, sem checar a idade dele. checkSupervisor (o
// status de topo) já detectava isso corretamente; esta tabela não.
const PROCESSES_SNAPSHOT_STALE_MS = 3 * 60 * 1000;

/**
 * Uma linha por processo supervisionado (+ telegram_radar, manual) --
 * Uptime/Restarts/CPU/RAM/Estado operacional (modelo de 7 estados).
 */
function formatProcessesTable(processesSnapshot, now = Date.now()) {
  if (!processesSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];

  const sampleAgeMs = processesSnapshot.sampledAt ? now - new Date(processesSnapshot.sampledAt).getTime() : null;
  const isStale = sampleAgeMs != null && sampleAgeMs > PROCESSES_SNAPSHOT_STALE_MS;

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
  const table = [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];

  if (!isStale) return table;
  return [
    `  ⚠️  AMOSTRA DESATUALIZADA (${fmtMs(sampleAgeMs)} atrás) -- se o metrics_sampler morreu junto com o resto, esta tabela não reflete o estado real. Confie no status "supervisor" acima, não nesta tabela.`,
    ...table,
  ];
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

const SAMPLE_CONFIDENCE_EMOJI = { LOW_CONFIDENCE: "🔴", MEDIUM_CONFIDENCE: "🟡", HIGH_CONFIDENCE: "🟢" };

/**
 * Sample Confidence vem primeiro de propósito -- é o aviso "não otimize a
 * estratégia em cima disso ainda" que precisa aparecer antes de qualquer
 * métrica, não depois.
 */
function formatSampleConfidence(sc) {
  if (!sc) return null;
  const emoji = SAMPLE_CONFIDENCE_EMOJI[sc.status] || "❔";
  return `  ${emoji} Sample Confidence: ${sc.totalTrades}/${sc.target} (${sc.pct}%) — ${sc.status}`;
}

function formatTradingSection(tradingSnapshot) {
  if (!tradingSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  if (tradingSnapshot.totalTrades === 0) return ["  (nenhum trade fechado registrado ainda)"];

  const pa = tradingSnapshot.portfolioAnalytics || {};
  const sampleConfidenceLine = formatSampleConfidence(tradingSnapshot.sampleConfidence);
  return [
    ...(sampleConfidenceLine ? [sampleConfidenceLine] : []),
    `  Trades: ${tradingSnapshot.totalTrades} | Win Rate: ${fmtPct(tradingSnapshot.winRate * 100, 1)} | Profit Factor: ${tradingSnapshot.profitFactor.toFixed(2)} | Expectância: ${fmtPct(tradingSnapshot.expectancy * 100, 3)}`,
    `  Drawdown máx: ${fmtPct(tradingSnapshot.maxDrawdown * 100, 2)} | Sharpe: ${tradingSnapshot.sharpe.toFixed(2)} | Sortino: ${typeof pa.sortino === "number" ? pa.sortino.toFixed(2) : "—"} | Recovery Factor: ${pa.recoveryFactor != null ? pa.recoveryFactor.toFixed(2) : "—"}`,
    `  Kelly Fraction: ${pa.kellyFraction != null ? pa.kellyFraction.toFixed(3) : "—"} | VaR(${pa.confidence ?? "?"}): ${pa.var != null ? fmtPct(pa.var * 100, 2) : "—"} | CVaR: ${pa.cvar != null ? fmtPct(pa.cvar * 100, 2) : "—"}`,
    `  Hold time médio: ${fmtMs(tradingSnapshot.averageHoldMs)} (${tradingSnapshot.tradesWithHoldData}/${tradingSnapshot.totalTrades} trades com esse dado)`,
  ];
}

/**
 * Exit Analytics -- de onde vem o lucro de verdade, por motivo de saída
 * (lib/exitAnalytics.js, computado dentro de Trading Health). "desconhecido"
 * é esperado pra trades fechados antes do campo `reason` existir nos logs
 * (Fase D) -- não é um erro, é dado antigo sem essa informação.
 */
function formatExitAnalyticsTable(tradingSnapshot) {
  if (!tradingSnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  const entries = Object.entries(tradingSnapshot.exitAnalytics || {});
  if (entries.length === 0) return ["  (nenhum trade fechado registrado ainda)"];
  const rows = entries
    .sort((a, b) => b[1].trades - a[1].trades)
    .map(([reason, s]) => [reason, s.trades, fmtPct(s.winRate * 100, 1), fmtPct(s.totalPnlPct * 100, 2), fmtPct(s.avgPnlPct * 100, 3)]);
  const header = ["Motivo", "Trades", "Win Rate", "PnL Total", "PnL Médio"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];
}

const QUALITY_STATUS_ICON = { "N/A": "⬜", WARNING: "⚠️", ERROR: "🔴", ok: "✅" };

/**
 * Uma linha por domínio de amostragem periódica -- Coverage/Gaps/Sanity
 * Pass Rate/Data Confidence Score. Domínios orientados a evento
 * (coinmarketcal/fred/fomc_calendar) não aparecem aqui (mesma exclusão
 * honesta já documentada em lib/dataCoverage.js).
 */
function formatQualityTable(qualitySnapshot) {
  if (!qualitySnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  const rows = Object.entries(qualitySnapshot.quality || {}).map(([domain, q]) => [
    domain,
    q.coverage?.coveragePct != null ? fmtPct(q.coverage.coveragePct, 1) : "—",
    q.gaps?.gapsCount ?? "—",
    q.sanity?.passRate != null ? fmtPct(q.sanity.passRate) : "—",
    q.dataConfidence?.score != null ? q.dataConfidence.score : "—",
  ]);
  if (rows.length === 0) return ["  (nenhum domínio amostrado ainda)"];
  const header = ["Domínio", "Coverage", "Gaps", "Sanity Pass Rate", "Data Confidence Score"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];
}

/**
 * Cross-Source Validation: mostra N/A/WARNING/ERROR/ok pra cada domínio de
 * mercado (candles/funding/open_interest) -- N/A é o estado ESPERADO hoje
 * (só existe Bybit), nunca deve aparecer como se fosse um problema.
 */
function formatCrossSourceSection(qualitySnapshot) {
  if (!qualitySnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  const entries = Object.entries(qualitySnapshot.crossSourceValidation || {});
  if (entries.length === 0) return ["  (nenhum domínio de mercado configurado pra validação cruzada)"];
  return entries.map(([domain, v]) => {
    const icon = QUALITY_STATUS_ICON[v.status] || "❔";
    return `  ${icon} ${domain}: ${v.status}${v.reason ? ` -- ${v.reason}` : ""}`;
  });
}

/**
 * Source Reliability: Operational Reliability (implementado) + Predictive
 * Reliability (reservado, mostrado honestamente como "— (fase futura)" em
 * vez de fabricar um número).
 */
function formatSourceReliabilitySection(qualitySnapshot) {
  if (!qualitySnapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];
  const rows = Object.entries(qualitySnapshot.sourceReliability || {}).map(([provider, s]) => [
    provider,
    s.operationalReliability?.score != null ? s.operationalReliability.score : "—",
    s.predictiveReliability != null ? s.predictiveReliability : "— (fase futura)",
  ]);
  if (rows.length === 0) return ["  (nenhuma fonte amostrada ainda)"];
  const header = ["Fonte", "Operational Reliability", "Predictive Reliability"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  return [padRow(header, widths), padRow(widths.map((w) => "-".repeat(w)), widths), ...rows.map((r) => padRow(r, widths))];
}

/**
 * Backup Health -- último backup diário (data/status/integridade/retenção/
 * espaço em disco). "never_ran" é honesto (não fabrica um "ok" antes do
 * primeiro backup existir).
 */
const BACKUP_STATUS_LABEL = { ok: "ok", stale: "atrasado", invalid: "INVÁLIDO (integrity_check falhou)", never_ran: "nunca rodou" };
const BACKUP_STATUS_ICON = { ok: "✅", stale: "⚠️", invalid: "🔴", never_ran: "⬜" };

function formatBackupSection(backupHealth) {
  if (!backupHealth) return ["  (sem dados -- backup daemon ainda não rodou)"];
  const icon = BACKUP_STATUS_ICON[backupHealth.status] || "❔";
  const label = BACKUP_STATUS_LABEL[backupHealth.status] || backupHealth.status;
  if (backupHealth.status === "never_ran") {
    return [`  ${icon} Backup: ${label} (rode \`npm run backup\` ou aguarde o backup_daemon supervisionado)`];
  }
  return [
    `  ${icon} Último backup: ${new Date(backupHealth.lastBackupAt).toISOString()} (${fmtMs(backupHealth.ageMs)} atrás) -- ${label}`,
    `  Integridade: ${backupHealth.integrityOk ? "ok" : "FALHOU"} | Retenção: ${backupHealth.retentionDays} dias | Espaço usado: ${fmtMb(backupHealth.diskUsageBytes)}`,
  ];
}

/**
 * Platform Availability (Fase C.2) -- uptime/downtime numa janela (default
 * 30 dias), lendo o agregado já calculado por lib/platformAvailability.js.
 * Sem incidente nenhum na janela, availabilityPct chega aqui como 100 de
 * verdade (não fabricado) -- mesma honestidade das outras seções.
 */
function fmtDowntime(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0 && m === 0) return "0min";
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

function formatPlatformAvailabilitySection(availability) {
  if (!availability) return ["  (sem dados)"];
  return [
    `  Uptime: ${fmtPct(availability.availabilityPct, 2)} (últimos ${availability.windowDays} dias)`,
    `  Downtime: ${fmtDowntime(availability.downtimeMs)}`,
    `  Incidentes: ${availability.totalIncidents} (${availability.unexpectedShutdowns} reboot/crash inesperado)`,
    `  Recuperação automática: ${availability.autoRecoveries}/${availability.totalIncidents}`,
  ];
}

/**
 * Market Brain (1º dos 5 Brains) -- cada eixo já vem no formato
 * {state, confidence, reasons, missingEvidence} de lib/brains/marketBrain.js,
 * só formata em texto. Puramente informativo: nenhuma decisão de trade
 * depende deste snapshot ainda.
 */
function formatMarketBrainSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- market.db ainda não existe ou não pôde ser lido)"];

  const axes = [
    { label: "Trend", axis: snapshot.trend },
    { label: "Sentiment", axis: snapshot.sentiment },
    { label: "Risk", axis: snapshot.risk },
  ];

  const lines = [];
  for (const { label, axis } of axes) {
    lines.push(`  ${label.padEnd(12)}${String(axis.state).padEnd(20)}${fmtPct(axis.confidence)}`);
    for (const reason of axis.reasons) lines.push(`              - ${reason}`);
    lines.push("");
  }

  lines.push(`  ${"Overall".padEnd(12)}${String(snapshot.state).padEnd(20)}${fmtPct(snapshot.confidence)} (score ${fmtPct(snapshot.score)})`);
  for (const reason of snapshot.reasons) lines.push(`              - ${reason}`);
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * Structure Brain -- state/confidence/score no topo (BrainResult comum),
 * swings/trend/liquidity/supportResistance como detalhe específico deste
 * Brain. Liquidity/Support-Resistance ficam "ainda não implementado"
 * (state null) nesta v1 -- honesto, não fabricado.
 */
function formatStructureBrainSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- market.db ainda não existe ou não pôde ser lido)"];

  const lines = [];
  lines.push(`  ${"Market Structure".padEnd(18)}${String(snapshot.state).padEnd(12)}conf ${fmtPct(snapshot.confidence)}  score ${fmtPct(snapshot.score)}`);
  for (const reason of snapshot.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  lines.push(`  ${"Liquidity".padEnd(18)}${snapshot.liquidity.state == null ? "— (ainda não implementado)" : snapshot.liquidity.state}`);
  lines.push(
    `  ${"Support/Resistance".padEnd(18)}${
      snapshot.supportResistance.nearestSupport == null && snapshot.supportResistance.nearestResistance == null
        ? "— (ainda não implementado)"
        : `suporte ${snapshot.supportResistance.nearestSupport} / resistência ${snapshot.supportResistance.nearestResistance}`
    }`
  );
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * Liquidity Brain -- zonas de liquidez (Equal Highs/Lows) e sweeps
 * recentes. `imbalances` (FVG, próxima fase) e trapped traders confirmado
 * por OI (precisa Context Fusion) ficam honestamente marcados como não
 * implementados/proxy nesta v1.
 */
function formatLiquidityBrainSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- market.db ainda não existe ou não pôde ser lido)"];

  const lines = [];
  lines.push(`  ${"Liquidity".padEnd(18)}${String(snapshot.state).padEnd(18)}conf ${fmtPct(snapshot.confidence)}  score ${fmtPct(snapshot.score)}`);
  for (const reason of snapshot.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  lines.push(`  Zonas acima do preço: ${snapshot.zones.above.length} | Zonas abaixo: ${snapshot.zones.below.length}`);
  lines.push(`  Sweeps detectados no histórico: ${snapshot.sweeps.length}`);
  if (snapshot.trappedTraders) {
    lines.push(
      `  Trapped traders (proxy, não confirmado por OI): ${snapshot.trappedTraders.side}, reversão ${
        snapshot.trappedTraders.confirmed === true ? "confirmada" : snapshot.trappedTraders.confirmed === false ? "ainda não confirmada" : "indeterminada"
      }`
    );
  }
  lines.push(`  Imbalances (FVG): — (ainda não implementado)`);
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * Context Fusion -- combina Market/Structure/Liquidity Brain só como
 * leitura. `conflicts` é o que mais importa aqui: mostra explicitamente
 * quando os Brains discordam entre si, motivo pelo qual a confiança
 * fundida pode ser bem menor que a média simples dos 3.
 */
function formatContextFusionSection(context) {
  if (!context) return ["  (sem dados -- Brains ainda não puderam ser calculados)"];

  const lines = [];
  lines.push(`  ${"Fusão".padEnd(18)}${String(context.state).padEnd(18)}conf ${fmtPct(context.confidence)}  score ${fmtPct(context.score)}`);
  for (const reason of context.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  lines.push(context.conflicts.length > 0 ? `  Conflitos detectados: ${context.conflicts.join(" | ")}` : "  Nenhum conflito detectado entre os Brains");
  for (const e of context.evidence) {
    lines.push(`  ${e.type.padEnd(18)}${String(e.payload.state).padEnd(20)}conf ${fmtPct(e.confidence)}  score ${fmtPct(e.payload.score)}`);
  }
  if (context.missingEvidence.length > 0) {
    lines.push(`  Brains ainda ausentes: ${context.missingEvidence.join(", ")}`);
  }

  return lines;
}

module.exports = {
  formatDomainsTable,
  formatProcessesTable,
  formatDatabaseSection,
  formatTradingSection,
  formatExitAnalyticsTable,
  formatQualityTable,
  formatCrossSourceSection,
  formatBackupSection,
  formatSourceReliabilitySection,
  formatPlatformAvailabilitySection,
  formatMarketBrainSection,
  formatStructureBrainSection,
  formatLiquidityBrainSection,
  formatContextFusionSection,
  fmtPct,
  fmtMs,
  fmtMb,
  fmtRatePerHour,
  fmtUptime,
};

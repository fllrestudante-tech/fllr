// Formatação pura do painel operacional (scripts/health.js consome isso) --
// nenhum fs aqui, só transforma o conteúdo já lido de runtime/metrics/*.json
// em linhas de texto. Testável sem tocar disco.
const { computeAllMaturityLevels } = require("./researchMaturity");

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
// Barra ASCII genérica (████░░░░) -- só formatação, não calcula nada.
function renderBar(fraction, width = 10) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function fmtRatePerHour(perMin) {
  return typeof perMin === "number" ? `${(perMin * 60).toFixed(1)}/h` : "—";
}
function fmtUsd(n) {
  if (typeof n !== "number") return "—";
  return `$${n < 0.01 && n > 0 ? n.toFixed(6) : n.toFixed(4)}`;
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

// Offline: sem heartbeat de sucesso recente o bastante (stale/nunca rodou).
// Degraded: recebendo dado mas atrasado ou com falha recente -- ainda não é
// "morto", mas já vale atenção antes de escalar o Universe.
// Healthy: fresh e sem falha consecutiva nenhuma.
function classifySymbolHealth({ freshnessState, consecutiveFailures }) {
  if (freshnessState === "stale" || freshnessState === "never_succeeded" || freshnessState === "sem_dado") return "offline";
  if (freshnessState === "late" || (consecutiveFailures ?? 0) > 0) return "degraded";
  return "healthy";
}

/**
 * Fase A (expansão multi-asset) -- 1 linha por símbolo do Universe
 * (lib/universe.js), coverage/sanity de candles + freshness/falhas
 * consecutivas/última coleta vindas do heartbeat do coletor. `rows` já vem
 * computado por quem chama (scripts/health.js) -- esta função só formata e
 * classifica (healthy/degraded/offline), mesmo padrão de formatDomainsTable.
 * `assetsDiscovered` opcional -- contagem de linhas auto-registradas em
 * `asset` (migração 0011), só pra contexto no topo da seção.
 */
function formatUniverseCoverageSection(rows, { assetsDiscovered } = {}) {
  if (!rows || rows.length === 0) return ["  (Universe vazio -- configure MARKET_SYMBOLS ou SYMBOL no .env)"];

  const health = rows.map((r) => classifySymbolHealth(r));
  const tableRows = rows.map((r, i) => [
    r.symbol,
    fmtPct(r.coveragePct),
    r.freshnessState ?? "—",
    r.consecutiveFailures ?? "—",
    r.sanityPassRate != null ? `${r.sanityPassRate}%` : "—",
    r.lastSuccessAt ? new Date(r.lastSuccessAt).toISOString() : "nunca",
    health[i],
  ]);

  const header = ["Símbolo", "Coverage", "Freshness", "Falhas seguidas", "Sanity", "Última coleta (UTC)", "Estado"];
  const widths = header.map((h, i) => Math.max(h.length, ...tableRows.map((r) => String(r[i]).length)));
  const counts = { healthy: 0, degraded: 0, offline: 0 };
  health.forEach((h) => counts[h]++);

  const summary = [`  Tracked: ${rows.length}`, `Healthy: ${counts.healthy}`, `Degraded: ${counts.degraded}`, `Offline: ${counts.offline}`];
  if (assetsDiscovered != null) summary.push(`Assets descobertos: ${assetsDiscovered}`);

  return [
    summary.join("  |  "),
    "",
    padRow(header, widths),
    padRow(widths.map((w) => "-".repeat(w)), widths),
    ...tableRows.map((r) => padRow(r, widths)),
  ];
}

/**
 * Fase A -- saturação do scheduler por domínio (candles/funding/...):
 * quantas requisições estão em voo (activeCount) e na fila (queuedCount)
 * agora. `stats` vem de runCollector::getSchedulerStats() via heartbeat do
 * coletor (lib/collectors/requestScheduler.js::createConcurrencyLimiter).
 */
function formatSchedulerSection(stats) {
  if (!stats) return ["  (sem dados -- coletor não está rodando ou heartbeat ainda não escreveu)"];

  const rows = Object.entries(stats).map(([domain, s]) => [domain, s.activeCount, s.queuedCount]);
  const header = ["Domínio", "Em voo", "Na fila"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const totalQueued = rows.reduce((sum, r) => sum + r[2], 0);

  return [
    `  Fila total: ${totalQueued}${totalQueued > 0 ? " (scheduler acumulando backlog -- considere reduzir maxConcurrent ou aumentar o intervalo)" : ""}`,
    "",
    padRow(header, widths),
    padRow(widths.map((w) => "-".repeat(w)), widths),
    ...rows.map((r) => padRow(r, widths)),
  ];
}

/**
 * Fase A -- throttling real da Bybit (lib/httpRetry.js::getRetryStats(),
 * acumulado desde o boot do processo coletor). `totalRuns` opcional (soma de
 * totalRuns de todos os domínios do collectorMetrics) só pra expressar
 * throttle% como fração dos ciclos totais, não um número solto sem escala.
 */
function formatRateLimitSection(rateLimitStats, { totalRuns } = {}) {
  if (!rateLimitStats) return ["  (sem dados -- coletor não está rodando ou heartbeat ainda não escreveu)"];

  const { totalRetries, total429, totalBackoffMs } = rateLimitStats;
  const throttlePct = totalRuns ? Math.round((total429 / totalRuns) * 1000) / 10 : null;

  return [
    `  429 (rate limit): ${total429}  |  Retries totais: ${totalRetries}  |  Backoff acumulado: ${fmtMs(totalBackoffMs)}${throttlePct != null ? `  |  Throttle: ${throttlePct}%` : ""}`,
  ];
}

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
  lines.push(`  Narrativa dominante: ${context.dominantNarrative}`);
  if (context.secondaryNarrative) lines.push(`  Narrativa secundária: ${context.secondaryNarrative}`);
  for (const reason of context.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  if (context.conflicts.length > 0) {
    lines.push("  Conflitos detectados:");
    for (const c of context.conflicts) lines.push(`    - [${c.severity}] ${c.brain}: ${c.reason}`);
  } else {
    lines.push("  Nenhum conflito detectado entre os Brains");
  }
  for (const e of context.evidence) {
    lines.push(`  ${e.type.padEnd(18)}${String(e.payload.state).padEnd(20)}conf ${fmtPct(e.confidence)}  score ${fmtPct(e.payload.score)}`);
  }
  if (context.missingEvidence.length > 0) {
    lines.push(`  Brains ainda ausentes: ${context.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * FVG Brain -- estado dos desequilíbrios de mercado, contextualizado
 * contra Structure/Liquidity/Context Fusion (não é um detector isolado).
 */
function formatFVGBrainSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- market.db ainda não existe ou não pôde ser lido)"];

  const lines = [];
  lines.push(`  ${"FVG".padEnd(18)}${String(snapshot.state).padEnd(14)}conf ${fmtPct(snapshot.confidence)}  score ${fmtPct(snapshot.score)}`);
  for (const reason of snapshot.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  lines.push(`  Gaps ativos: ${snapshot.activeGaps.length} | Preenchidos: ${snapshot.filledGaps.length} | Empilhados: ${snapshot.stackedGaps.length}`);
  if (snapshot.nearestGap) {
    lines.push(
      `  Gap mais próximo: ${snapshot.nearestGap.direction} [${snapshot.nearestGap.low.toFixed(2)}-${snapshot.nearestGap.high.toFixed(2)}] -- ${snapshot.nearestGap.fillState}`
    );
  }
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

function formatOrderBlockBrainSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- market.db ainda não existe ou não pôde ser lido)"];

  const lines = [];
  lines.push(`  ${"Order Block".padEnd(18)}${String(snapshot.state).padEnd(14)}conf ${fmtPct(snapshot.confidence)}  score ${fmtPct(snapshot.score)}`);
  lines.push(`                    strength ${fmtPct(snapshot.strength)}  freshness ${fmtPct(snapshot.freshness)}`);
  for (const reason of snapshot.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  lines.push(
    `  Ativos: ${snapshot.activeBlocks.length} | Mitigados: ${snapshot.mitigatedBlocks.length} | Rompidos: ${snapshot.brokenBlocks.length} | Invalidados: ${snapshot.invalidatedBlocks.length}`
  );
  if (snapshot.dominantBlock) {
    const dominant = snapshot.dominantBlock;
    lines.push(
      `  Bloco dominante: ${dominant.direction} [${dominant.low.toFixed(2)}-${dominant.high.toFixed(2)}] -- ${dominant.stage} (${dominant.alignment.agreeing} a favor, ${dominant.alignment.opposing} contra)`
    );
  }
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * Só lê o resumo já persistido por `npm run replay` (scripts/replayEngine.js)
 * -- reprocessar o histórico inteiro a cada `npm run health` seria caro e é
 * a ferramenta errada pro job (replay é um batch sob demanda).
 */
function formatReplaySummarySection(stats) {
  if (!stats) return ["  (replay ainda não rodou -- use `npm run replay`)"];

  const lines = [];
  lines.push(`  Última rodada: ${stats.generatedAt}`);
  lines.push(`  ${stats.snapshotCount} snapshots sobre ${stats.candleCount} candles contíguos`);
  lines.push(`  Vereditos: ${Object.entries(stats.outcomeCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");
  for (const [comboName, rows] of Object.entries(stats.combos)) {
    if (rows.length === 0) continue;
    lines.push(`  Combo ${comboName} (top 3 por contagem):`);
    for (const row of rows.slice(0, 3)) {
      lines.push(`    - ${row.comboKey} -- ${row.count}x, acerto ${row.successRate}% (${row.confidenceLabel}), retorno médio ${row.avgForwardReturnPct}%, drawdown médio ${row.avgDrawdownPct}%`);
    }
  }

  if (stats.brainAccuracy) {
    lines.push("");
    lines.push("  Brain Analytics -- acurácia por Brain isolado:");
    for (const b of stats.brainAccuracy) {
      lines.push(`    - ${b.brainKey.padEnd(14)} acurácia ${b.accuracy}% | precisão ${b.precision}% | recall ${b.recall}% (${b.totalCalls} apostas)`);
    }
  }

  if (stats.marginalContribution) {
    lines.push("");
    lines.push("  Contribuição marginal (unanimidade crescente):");
    for (const row of stats.marginalContribution) {
      lines.push(`    - +${row.combo[row.combo.length - 1]} -- amostra ${row.sampleSize}, acurácia ${row.accuracy}%`);
    }
  }

  if (stats.redundancy) {
    lines.push("");
    lines.push("  Redundância:");
    for (const r of stats.redundancy) {
      lines.push(`    - ${r.explainerBrainKeys.join("+")} explica ${r.agreementRatePct}% do ${r.targetBrainKey} (amostra ${r.sampleSize})`);
    }
  }

  if (stats.decisionBrainReadiness) {
    const r = stats.decisionBrainReadiness;
    lines.push("");
    lines.push(`  Decision Brain: ${r.ready ? "PRONTO" : "ainda não"}`);
    lines.push(`    - Amostra: ${r.checks.sampleSize.pass ? "OK" : "faltando"} (${r.checks.sampleSize.count}/${r.checks.sampleSize.required})`);
    lines.push(`    - Diversidade de regime: ${r.checks.regimeDiversity.pass ? "OK" : "faltando"} (${JSON.stringify(r.checks.regimeDiversity.counts)})`);
    lines.push(`    - Estabilidade: ${r.checks.stability.pass ? "OK" : "faltando"} (spread ${r.checks.stability.spreadPct}pp, tolerância ${r.checks.stability.tolerancePp}pp)`);
  }

  return lines;
}

/**
 * Research Dashboard -- não decide nada, não valida nada novo. Só lê
 * data/replay/stats.json (Replay Engine + Brain Analytics, intocados) e
 * lib/researchMaturity.js (leitura derivada, sem I/O própria) pra dar uma
 * visão rápida de "quão maduro" cada Brain está, evitando promoção
 * prematura pra produção.
 */
function formatResearchDashboardSection(stats, minSnapshotsForDecisionBrain) {
  if (!stats) return ["  (replay ainda não rodou -- use `npm run replay`)"];

  const lines = [];
  const readiness = stats.decisionBrainReadiness;
  const gradedCount = readiness?.checks?.sampleSize?.count ?? stats.snapshotCount;
  const progressFraction = minSnapshotsForDecisionBrain > 0 ? gradedCount / minSnapshotsForDecisionBrain : 0;

  lines.push("  Replay snapshots:");
  lines.push(`  ${gradedCount} / ${minSnapshotsForDecisionBrain}`);
  lines.push(`  ${renderBar(progressFraction, 20)}  ${(progressFraction * 100).toFixed(1)}%`);
  lines.push("");

  lines.push("  Brains avaliados:");
  for (const b of stats.brainAccuracy || []) {
    lines.push(`    ${b.totalCalls > 0 ? "✓" : "✗"} ${b.brainKey}`);
  }
  lines.push("");

  const regimeCounts = readiness?.checks?.regimeDiversity?.counts || {};
  const totalRegime = Object.values(regimeCounts).reduce((sum, c) => sum + c, 0) || 1;
  lines.push("  Regimes:");
  lines.push(`    Bull  ${renderBar((regimeCounts.FUSED_BULLISH || 0) / totalRegime, 10)}`);
  lines.push(`    Bear  ${renderBar((regimeCounts.FUSED_BEARISH || 0) / totalRegime, 10)}`);
  lines.push(`    Range ${renderBar((regimeCounts.FUSED_NEUTRAL || 0) / totalRegime, 10)}`);
  lines.push("");

  lines.push("  Decision Brain:");
  lines.push(`    Status: ${readiness?.ready ? "LIBERADO" : "LOCKED"}`);
  if (readiness && !readiness.ready) {
    const reasons = [];
    if (!readiness.checks.sampleSize.pass) reasons.push("amostra insuficiente");
    if (!readiness.checks.regimeDiversity.pass) reasons.push("diversidade de regime insuficiente");
    if (!readiness.checks.stability.pass) reasons.push("instabilidade ao longo do tempo");
    lines.push(`    Motivo: ${reasons.join(", ")}`);
  }
  lines.push("");

  lines.push("  Research Maturity:");
  for (const m of computeAllMaturityLevels(stats, minSnapshotsForDecisionBrain)) {
    lines.push(`    ${m.brainKey.padEnd(16)} Level ${m.level} (${m.label})`);
  }

  return lines;
}

function formatInstitutionalContextSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- Brains ainda não puderam ser calculados)"];

  const lines = [];
  lines.push(`  ${"Confluência".padEnd(18)}${String(snapshot.state).padEnd(20)}conf ${fmtPct(snapshot.confidence)}  score ${fmtPct(snapshot.score)}`);
  for (const reason of snapshot.reasons) lines.push(`                    - ${reason}`);
  lines.push("");
  if (snapshot.zones.length > 0) {
    lines.push("  Zonas de confluência ativas:");
    for (const z of snapshot.zones) {
      lines.push(`    - ${z.direction} [${z.low.toFixed(2)}-${z.high.toFixed(2)}] -- ${z.sources.join("+")}`);
    }
  } else {
    lines.push("  Nenhuma zona de confluência ativa no momento");
  }
  if (snapshot.missingEvidence.length > 0) {
    lines.push(`  Evidências ainda ausentes: ${snapshot.missingEvidence.join(", ")}`);
  }

  return lines;
}

/**
 * AI Gateway Cost (2026-08-11) -- lê o snapshot já calculado por
 * lib/aiGateway/costMetrics.js (via scripts/metricsSampler.js), não
 * recalcula nada aqui. Assessment (1 invocação de getAssessment(), 1 linha
 * do log) e Provider Attempt (1 tentativa contra 1 provider dentro de um
 * assessment -- fallback = 2 tentativas) são contados separadamente de
 * propósito, ver comentário de topo de costMetrics.js. `isFullWindow=false`
 * aparece quando o log ainda não cobre um dia inteiro -- evita ler o número
 * como uma taxa diária estável antes da hora.
 */
function formatAiCostSection(snapshot) {
  if (!snapshot) return ["  (sem dados -- metrics sampler ainda não rodou)"];

  const costLine = snapshot.AI_COST_ESTIMATE_INCOMPLETE
    ? `  AI_COST_ESTIMATE_24H: ${fmtUsd(snapshot.AI_COST_ESTIMATE_24H)}+ (estimativa PARCIAL -- piso, custo real pode ser maior: ${snapshot.AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H} tentativa(s) remota(s) sem consumo conhecido, ${snapshot.AI_UNPRICED_ATTEMPTS_24H} sem preço configurado, ${snapshot.AI_MISSING_TOKEN_USAGE_24H} sucesso(s) sem usage no log)`
    : `  AI_COST_ESTIMATE_24H: ${fmtUsd(snapshot.AI_COST_ESTIMATE_24H)}`;

  const cachedPct =
    snapshot.AI_INPUT_TOKENS_24H > 0 ? ` (${((snapshot.AI_CACHED_INPUT_TOKENS_24H / snapshot.AI_INPUT_TOKENS_24H) * 100).toFixed(1)}% em cache)` : "";

  const lines = [
    `  AI_ASSESSMENTS_24H: ${snapshot.AI_ASSESSMENTS_24H} (sucesso ${snapshot.AI_ASSESSMENTS_24H_SUCCESS} | falha total ${snapshot.AI_ASSESSMENTS_24H_PROVIDER_ERROR} | sem provider configurado ${snapshot.AI_ASSESSMENTS_24H_NO_PROVIDER})`,
    `  AI_PROVIDER_ATTEMPTS_24H: ${snapshot.AI_PROVIDER_ATTEMPTS_24H} (sucesso ${snapshot.AI_PROVIDER_ATTEMPTS_24H_SUCCESS} | falha ${snapshot.AI_PROVIDER_ATTEMPTS_24H_FAILED})`,
    `  AI_INPUT_TOKENS_24H: ${snapshot.AI_INPUT_TOKENS_24H.toLocaleString("pt-BR")}${cachedPct} | cache=${snapshot.AI_CACHED_INPUT_TOKENS_24H.toLocaleString("pt-BR")}`,
    `  AI_OUTPUT_TOKENS_24H: ${snapshot.AI_OUTPUT_TOKENS_24H.toLocaleString("pt-BR")} | reasoning=${snapshot.AI_REASONING_TOKENS_24H.toLocaleString("pt-BR")}`,
    costLine,
    `  AI_COST_ESTIMATE_30D: ${fmtUsd(snapshot.AI_COST_ESTIMATE_30D)}${snapshot.AI_COST_ESTIMATE_INCOMPLETE ? "+" : ""} (extrapolação linear × 30 a partir da janela de 24h, não 30 dias reais ainda)`,
  ];

  if (snapshot.unpricedModels?.length) {
    lines.push(`  Modelos sem preço configurado: ${snapshot.unpricedModels.join(", ")}`);
  }

  if (!snapshot.isFullWindow) {
    lines.push(`  ⚠️  Janela ainda parcial: só ${snapshot.sampleWindowHours}h de log real existem (de ${snapshot.windowHours}h pedidas) -- números acima não são uma taxa diária estável ainda`);
  }

  if (Object.keys(snapshot.byProvider || {}).length > 0) {
    lines.push("  Por provider:");
    for (const [provider, p] of Object.entries(snapshot.byProvider)) {
      lines.push(
        `    ${provider.padEnd(10)} tentativas=${p.attempts} (✓${p.successAttempts}/✗${p.failedAttempts}) tokens=${p.inputTokens}(cache ${p.cachedInputTokens})/${p.outputTokens}(reasoning ${p.reasoningTokens}) custo=${fmtUsd(p.costUsd)}${p.unpricedAttempts || p.missingUsageAttempts ? ` (${p.unpricedAttempts} sem preço, ${p.missingUsageAttempts} sem usage)` : ""}`
      );
    }
  }

  return lines;
}

module.exports = {
  formatDomainsTable,
  formatUniverseCoverageSection,
  formatSchedulerSection,
  formatRateLimitSection,
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
  formatFVGBrainSection,
  formatOrderBlockBrainSection,
  formatInstitutionalContextSection,
  formatReplaySummarySection,
  formatResearchDashboardSection,
  formatAiCostSection,
  fmtPct,
  fmtMs,
  fmtMb,
  fmtUsd,
  fmtRatePerHour,
  fmtUptime,
  renderBar,
};

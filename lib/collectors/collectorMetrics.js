/**
 * Métricas de coleta por domínio (candles/funding/open_interest/... de
 * qualquer coletor, não só Bybit) -- runs, quantos de fato inseriram dado
 * novo vs. foram pulados por já existir, erros, falhas consecutivas,
 * latência da última chamada. É a base que alimenta tanto o health check
 * (lib/healthChecks.js) quanto, mais pra frente, o Data Quality Score por
 * fonte (Source Reliability Engine, ainda não implementado).
 *
 * Além dos contadores cumulativos (desde o boot do processo), cada domínio
 * também acumula uma janela deslizante (`windowMs`, default 5min) que fecha
 * sozinha na próxima chamada depois que o tempo da janela passa -- sem timer
 * próprio, sem setInterval. `lastWindow` guarda a janela mais recente já
 * fechada (estável entre leituras); a janela "aberta" (`windowRuns`/etc.) só
 * vira `lastWindow` quando fecha, evitando ler uma janela parcial e
 * confundir uma taxa baixa com uma taxa real. lib/throughput.js transforma
 * isso em taxas por minuto -- este módulo só acumula contagens.
 */
function createCollectorMetrics({ now = Date.now, windowMs = 5 * 60 * 1000 } = {}) {
  const domains = {};

  function ensure(domain) {
    if (!domains[domain]) {
      domains[domain] = {
        totalRuns: 0,
        totalInserted: 0,
        totalSkipped: 0,
        totalErrors: 0,
        totalPaused: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastLatencyMs: null,
        lastError: null,
        windowStartedAt: now(),
        windowRuns: 0,
        windowInserted: 0,
        windowErrors: 0,
        lastWindow: null,
      };
    }
    return domains[domain];
  }

  function rollWindowIfNeeded(m, nowMs) {
    if (nowMs - m.windowStartedAt < windowMs) return;
    m.lastWindow = {
      runs: m.windowRuns,
      inserted: m.windowInserted,
      errors: m.windowErrors,
      closedAt: new Date(nowMs).toISOString(),
      durationMs: nowMs - m.windowStartedAt,
    };
    m.windowStartedAt = nowMs;
    m.windowRuns = 0;
    m.windowInserted = 0;
    m.windowErrors = 0;
  }

  function recordSuccess(domain, { inserted = false, latencyMs = null } = {}) {
    const m = ensure(domain);
    const nowMs = now();
    rollWindowIfNeeded(m, nowMs);

    m.totalRuns++;
    m.windowRuns++;
    if (inserted) {
      m.totalInserted++;
      m.windowInserted++;
    } else {
      m.totalSkipped++;
    }
    m.consecutiveFailures = 0;
    m.lastRunAt = new Date(nowMs).toISOString();
    m.lastSuccessAt = m.lastRunAt;
    m.lastLatencyMs = latencyMs;
    m.lastError = null;
  }

  // Pausa intencional (Connectivity Manager detectou o provider fora do ar)
  // não é falha -- não conta pra consecutiveFailures nem gera alerta de erro,
  // só documenta que o tick foi pulado de propósito em vez de tentar e falhar.
  function recordPaused(domain) {
    const m = ensure(domain);
    const nowMs = now();
    rollWindowIfNeeded(m, nowMs);
    m.totalPaused++;
    m.lastRunAt = new Date(nowMs).toISOString();
  }

  function recordFailure(domain, err, { latencyMs = null } = {}) {
    const m = ensure(domain);
    const nowMs = now();
    rollWindowIfNeeded(m, nowMs);

    m.totalRuns++;
    m.windowRuns++;
    m.totalErrors++;
    m.windowErrors++;
    m.consecutiveFailures++;
    m.lastRunAt = new Date(nowMs).toISOString();
    m.lastLatencyMs = latencyMs;
    m.lastError = err.message;
  }

  // cópia rasa via JSON -- evita que quem chama getMetrics() mute o estado interno sem querer
  function getMetrics() {
    return JSON.parse(JSON.stringify(domains));
  }

  return { recordSuccess, recordFailure, recordPaused, getMetrics };
}

module.exports = { createCollectorMetrics };

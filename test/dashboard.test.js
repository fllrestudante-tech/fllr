const test = require("node:test");
const assert = require("node:assert/strict");
const { formatDomainsTable, formatProcessesTable, formatDatabaseSection, formatTradingSection, fmtUptime, fmtMb, fmtRatePerHour } = require("../lib/dashboard");

test("fmtUptime: formata horas+minutos ou só minutos", () => {
  const now = new Date("2026-07-16T12:00:00.000Z").getTime();
  assert.equal(fmtUptime(new Date(now - 90 * 60000).toISOString(), now), "1h30m");
  assert.equal(fmtUptime(new Date(now - 5 * 60000).toISOString(), now), "5m");
  assert.equal(fmtUptime(null, now), "—");
});

test("fmtMb: converte bytes pra MB com 1 casa decimal", () => {
  assert.equal(fmtMb(1048576), "1.0MB");
  assert.equal(fmtMb(null), "—");
});

test("fmtRatePerHour: converte taxa/min pra taxa/hora", () => {
  assert.equal(fmtRatePerHour(1), "60.0/h");
  assert.equal(fmtRatePerHour(null), "—");
});

test("formatDomainsTable: sem snapshot ainda, mensagem honesta (não quebra)", () => {
  const result = formatDomainsTable(null);
  assert.ok(result[0].includes("sampler ainda não rodou"));
});

test("formatDomainsTable: uma linha por domínio, cabeçalho + separador + dados", () => {
  const snapshot = {
    collectors: {
      bybit_collector: {
        domains: {
          candles: { freshness: { score: 100, state: "fresh" }, lastSuccessAt: "2026-07-16T10:00:00.000Z", insertedPerMin: 1, totalErrors: 0, apiHealth: { score: 100 } },
        },
      },
    },
  };
  const result = formatDomainsTable(snapshot);
  assert.equal(result.length, 3); // header + separador + 1 linha
  assert.ok(result[0].includes("Domínio"));
  assert.ok(result[2].includes("candles"));
});

test("formatProcessesTable: uma linha por processo, mostra estado degraded quando aplicável", () => {
  const now = new Date("2026-07-16T12:00:00.000Z").getTime();
  const snapshot = {
    processes: {
      bot: { operationalState: "RUNNING", degraded: false, startedAt: new Date(now - 60000).toISOString(), totalRestarts: 0, cpuPercent: 0, ramBytes: 30000000 },
      bybit_collector: { operationalState: "RUNNING", degraded: true, startedAt: new Date(now - 60000).toISOString(), totalRestarts: 2, cpuPercent: 5, ramBytes: 20000000 },
    },
  };
  const result = formatProcessesTable(snapshot, now);
  assert.ok(result.some((l) => l.includes("RUNNING (degraded)")));
});

test("formatProcessesTable: snapshot fresco (sampledAt recente) não mostra aviso de desatualização", () => {
  const now = new Date("2026-07-16T12:00:00.000Z").getTime();
  const snapshot = {
    sampledAt: new Date(now - 30000).toISOString(), // 30s atrás, dentro do limite
    processes: { bot: { operationalState: "RUNNING", startedAt: new Date(now - 60000).toISOString() } },
  };
  const result = formatProcessesTable(snapshot, now);
  assert.ok(!result.some((l) => l.includes("DESATUALIZADA")));
});

test("formatProcessesTable: snapshot congelado (ex: metrics_sampler morreu junto com o resto) avisa que a tabela pode estar errada", () => {
  const now = new Date("2026-07-16T12:00:00.000Z").getTime();
  const snapshot = {
    sampledAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(), // 8h atrás -- mesmo achado real desta sessão
    processes: { bot: { operationalState: "RUNNING", startedAt: new Date(now - 9 * 60 * 60 * 1000).toISOString() } },
  };
  const result = formatProcessesTable(snapshot, now);
  assert.ok(result[0].includes("DESATUALIZADA"));
  assert.ok(result.some((l) => l.includes("bot"))); // tabela continua presente, só com o aviso antes
});

test("formatDatabaseSection: sem snapshot, mensagem honesta", () => {
  assert.ok(formatDatabaseSection(null)[0].includes("sampler ainda não rodou"));
});

test("formatDatabaseSection: com dado, reporta VACUUM/integridade/insert-select honestamente", () => {
  const snapshot = { sizeBytes: 1048576, fragmentationRatio: 0.05, vacuumNeeded: false, integrity: { ok: true, detail: "ok" }, insertedPerSec: 0.5, selectPerSec: { reason: "workload é majoritariamente escrita" } };
  const lines = formatDatabaseSection(snapshot);
  assert.ok(lines.some((l) => l.includes("não")));
  assert.ok(lines.some((l) => l.includes("não rastreado")));
});

test("formatTradingSection: sem trades, mensagem honesta em vez de métricas fabricadas", () => {
  const result = formatTradingSection({ totalTrades: 0 });
  assert.ok(result[0].includes("nenhum trade"));
});

test("formatTradingSection: com trades, mostra as métricas principais", () => {
  const snapshot = {
    totalTrades: 4,
    winRate: 0.75,
    profitFactor: 17.8,
    expectancy: 0.0025,
    maxDrawdown: 0.0006,
    sharpe: 1.4,
    averageHoldMs: null,
    tradesWithHoldData: 0,
    portfolioAnalytics: { sortino: 8.4, recoveryFactor: 16.8, kellyFraction: 0.7, var: null, cvar: null, confidence: 0.95 },
  };
  const lines = formatTradingSection(snapshot);
  assert.ok(lines[0].includes("Trades: 4"));
});

test("formatTradingSection: com sampleConfidence, mostra o aviso ANTES das métricas", () => {
  const snapshot = {
    totalTrades: 11,
    winRate: 0.4545,
    profitFactor: 0.97,
    expectancy: -0.00005,
    maxDrawdown: 0.0155,
    sharpe: -0.01,
    averageHoldMs: null,
    tradesWithHoldData: 0,
    sampleConfidence: { totalTrades: 11, target: 100, pct: 11, status: "LOW_CONFIDENCE" },
    portfolioAnalytics: {},
  };
  const lines = formatTradingSection(snapshot);
  assert.ok(lines[0].includes("Sample Confidence: 11/100 (11%)"));
  assert.ok(lines[0].includes("LOW_CONFIDENCE"));
  assert.ok(lines[1].includes("Trades: 11"));
});

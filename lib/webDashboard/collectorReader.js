// Página Collectors -- mesma orquestração de scripts/health.js::
// readUniverseHealth (Fase A), reescrita aqui porque scripts/health.js é um
// entrypoint CLI com efeito colateral no require (dispara main() no fim do
// arquivo), não uma lib segura de importar. As peças por baixo são as
// mesmas funções exportadas (getUniverse/sampleCoverage/sampleSanityChecks/
// computeFreshnessScore) -- nenhuma métrica é recalculada, só reorquestrada.
const fs = require("fs");
const { DEFAULT_DB_PATH } = require("../infra/db");
const { withReadonlyDb } = require("../infra/withReadonlyDb");
const { getUniverse } = require("../universe");
const { sampleCoverage } = require("../dataCoverage");
const { sampleSanityChecks } = require("../sanityChecks");
const { computeFreshnessScore } = require("../freshnessScore");
const checks = require("../healthChecks");

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readCollectors({ dbPath = DEFAULT_DB_PATH, symbols, heartbeatPath = checks.DEFAULT_COLLECTOR_HEALTH_FILE } = {}) {
  const symbolsList = symbols ?? getUniverse().symbols;
  const heartbeat = readJson(heartbeatPath);
  const bySymbol = heartbeat?.metrics?.candles?.bySymbol || {};

  const rows = withReadonlyDb(
    dbPath,
    (db) =>
      symbolsList.map((symbol) => {
        const coverage = sampleCoverage("candles", db, { symbol });
        const sanity = sampleSanityChecks("candles", db, { windowMs: coverage.windowMs, symbol });
        const symbolMetrics = bySymbol[symbol];
        const freshness = symbolMetrics?.lastSuccessAt ? computeFreshnessScore("candles", symbolMetrics.lastSuccessAt) : null;
        return {
          symbol,
          coveragePct: coverage.coveragePct,
          freshnessState: freshness?.state ?? "sem_dado",
          consecutiveFailures: symbolMetrics?.consecutiveFailures ?? null,
          sanityPassRate: sanity.passRate,
          lastSuccessAt: symbolMetrics?.lastSuccessAt ?? null,
        };
      }),
    symbolsList.map((symbol) => ({ symbol, coveragePct: null, freshnessState: "sem_dado", consecutiveFailures: null, sanityPassRate: null, lastSuccessAt: null }))
  );

  return {
    universe: symbolsList,
    rows,
    schedulerStats: heartbeat?.schedulerStats ?? null,
    rateLimitStats: heartbeat?.rateLimitStats ?? null,
  };
}

module.exports = { readCollectors };

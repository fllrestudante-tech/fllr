// Teste de RASTREABILIDADE ponta a ponta -- diferente dos testes
// unitários de cada módulo (que já existem em funding.test.js/
// volatility.test.js/etc), este prova que a cadeia inteira
// Market DB -> Asset Statistics -> Statistical Resolver -> Feature
// Builder não perde nem distorce informação em nenhum salto. Cada teste
// planta um valor bruto conhecido, lê o Resolver, lê a Feature, e
// confere as 4 camadas concordam (não que uma "confia cegamente" na
// outra -- o Feature Builder calcula seu PRÓPRIO nível a partir de
// `observation`, não copia `interpretation.level` do Resolver, ver
// lib/featureBuilder/levelFromPercentile.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations } = require("../../lib/infra/db");
const { upsertAssetStatistics } = require("../../lib/knowledgeBase/assetStatisticsStore");
const { resolveMetricSignal } = require("../../lib/knowledgeBase/statisticalResolver");
const { buildFundingExtreme } = require("../../lib/featureBuilder/funding");
const { buildVolatilityCompression, buildVolatilityExpansion } = require("../../lib/featureBuilder/volatility");

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const WINDOW = { windowCandles: 100, coveragePct: 95, freshnessScore: 100, missingRate: 0.05, duplicateRate: 0, gapRate: 0, sampleSize: 100, effectiveSampleSize: 95, confidence: 95, computedAt: new Date().toISOString() };
const BASE_METRIC = {
  sampleSize: 100, avg: 1, median: 1, stddev: 0.1, min: 0.5, max: 1.5,
  p10: 0.8, p25: 0.9, p50: 1, p75: 1.1, p90: 1.2, p95: 1.3, p99: 1.4,
  mad: 0.05, iqr: 0.2, trimmedMean: 1, winsorizedMean: 1, skewness: 0, kurtosis: 0,
  trend: "flat", velocity: 0, acceleration: 0, persistence: 1, compressionExpansion: "stable",
  stabilityScore: 90, quality: "high", confidence: 95, driftPct: 0,
};

test("Rastreabilidade: Funding percentile 98 -> Resolver EXTREME -> FundingExtreme EXTREME", () => {
  const db = freshDb();

  // Camada 1 (Market DB via Asset Statistics): planta um percentil bruto conhecido.
  upsertAssetStatistics(db, "BTCUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 0.0009, percentileCurrent: 98, zscoreCurrent: 3.4 } },
  });

  // Camada 2 (Statistical Resolver): confirma que o fato bruto virou o julgamento esperado.
  const signal = resolveMetricSignal(db, "BTCUSDT", "funding", { windowDays: 30 });
  assert.equal(signal.observation.percentile, 98, "Resolver devolveu o percentil exatamente como gravado -- sem perda de precisão");
  assert.equal(signal.interpretation.level, "EXTREME", "Resolver interpretou percentil 98 como EXTREME (>=95)");
  assert.equal(signal.interpretation.direction, "above");

  // Camada 3 (Feature Builder): confirma que a Feature chega à MESMA conclusão
  // de forma INDEPENDENTE (via levelFromPercentile, não copiando signal.interpretation).
  const feature = buildFundingExtreme(signal);
  assert.equal(feature.observation.percentile, 98, "Feature preservou o percentil bruto sem alterar");
  assert.equal(feature.observation.resolverInterpretation.level, "EXTREME", "referência auxiliar do Resolver está correta dentro da Feature");
  assert.equal(feature.interpretation.state, "EXTREME", "Feature Builder chegou à mesma conclusão de forma independente");
  assert.equal(feature.interpretation.direction, "above");
  assert.equal(feature.id, "FEATURE_FUNDING_EXTREME");

  // Camada 4 (estado final consumível): nada se perdeu entre o dado bruto e o veredito.
  assert.equal(feature.strength > 50, true, "zscore 3.4 deveria produzir strength alto (85)");

  db.close();
});

test("Rastreabilidade: Funding percentile 50 (normal) -> Resolver NORMAL -> FundingExtreme NORMAL (não falso-positivo)", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "BTCUSDT", "global", 30, {
    window: WINDOW,
    metrics: { funding: { ...BASE_METRIC, currentValue: 0.0001, percentileCurrent: 50, zscoreCurrent: 0 } },
  });

  const signal = resolveMetricSignal(db, "BTCUSDT", "funding", { windowDays: 30 });
  assert.equal(signal.interpretation.level, "NORMAL");

  const feature = buildFundingExtreme(signal);
  assert.equal(feature.interpretation.state, "NORMAL", "percentil normal nunca deveria disparar EXTREME em nenhuma camada");
  db.close();
});

test("Rastreabilidade: ATR compressionExpansion='compressing' -> VolatilityCompression HIGH, VolatilityExpansion NORMAL", () => {
  const db = freshDb();

  // Camada 1: planta o campo bruto que lib/knowledgeBase/statisticsComputer.js
  // já teria calculado a partir da série de true range.
  upsertAssetStatistics(db, "BTCUSDT", "global", 30, {
    window: WINDOW,
    metrics: { atr: { ...BASE_METRIC, currentValue: 20, percentileCurrent: 50, zscoreCurrent: 0, compressionExpansion: "compressing" } },
  });

  // Camada 2: Resolver expõe o campo sem alterar.
  const signal = resolveMetricSignal(db, "BTCUSDT", "atr", { windowDays: 30 });
  assert.equal(signal.observation.compressionExpansion, "compressing", "Resolver não distorce o campo já calculado por statisticsComputer.js");

  // Camada 3: Feature Builder lê compressionExpansion diretamente de
  // `observation` (nunca de `interpretation.level`, que nem existe pra esse
  // conceito) -- confirma o roteamento certo pras 2 Features irmãs.
  const compression = buildVolatilityCompression(signal);
  const expansion = buildVolatilityExpansion(signal);
  assert.equal(compression.interpretation.state, "HIGH", "compressing -> VolatilityCompression HIGH");
  assert.equal(expansion.interpretation.state, "NORMAL", "compressing -> VolatilityExpansion NORMAL (são mutuamente exclusivas)");

  db.close();
});

test("Rastreabilidade: ATR compressionExpansion='expanding' -> VolatilityExpansion HIGH, VolatilityCompression NORMAL (caminho espelhado)", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "BTCUSDT", "global", 30, {
    window: WINDOW,
    metrics: { atr: { ...BASE_METRIC, currentValue: 20, percentileCurrent: 50, zscoreCurrent: 0, compressionExpansion: "expanding" } },
  });

  const signal = resolveMetricSignal(db, "BTCUSDT", "atr", { windowDays: 30 });
  const compression = buildVolatilityCompression(signal);
  const expansion = buildVolatilityExpansion(signal);
  assert.equal(expansion.interpretation.state, "HIGH");
  assert.equal(compression.interpretation.state, "NORMAL");
  db.close();
});

test("Rastreabilidade: proveniência (resolverVersion/statisticsVersion) trafega intacta da Storage até a Feature", () => {
  const db = freshDb();
  upsertAssetStatistics(db, "BTCUSDT", "global", 30, { window: WINDOW, metrics: { funding: { ...BASE_METRIC, currentValue: 1, percentileCurrent: 98, zscoreCurrent: 3 } } });

  const signal = resolveMetricSignal(db, "BTCUSDT", "funding", { windowDays: 30 });
  const feature = buildFundingExtreme(signal);

  assert.equal(feature.metadata.statisticsVersion, signal.evidence.statisticsVersion, "Feature carrega exatamente a mesma statisticsVersion que o Resolver leu da tabela");
  assert.equal(feature.metadata.resolverVersion, signal.evidence.resolverVersion, "Feature carrega exatamente o mesmo resolverVersion que o Resolver reportou");
  db.close();
});

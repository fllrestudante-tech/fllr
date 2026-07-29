// CLI fina sobre a Market Knowledge Base -- só chama lib/knowledgeBase/*,
// nenhuma lógica nova aqui além de parsing de argv e formatação de saída.
// Uso: npm run knowledge-base -- <show|set> <symbol> [flags]
const { openDb } = require("../lib/infra/db");
const { getAsset, upsertAsset } = require("../lib/knowledgeBase/assetStore");
const { buildStructureContext, buildLiquidityContext, buildFvgContext, buildOrderBlockContext } = require("../lib/knowledgeBase/contextBuilder");
const { REAL, FUTURE } = require("../lib/knowledgeBase/consumers");
const { computeAssetStatistics, DEFAULT_WINDOW_DAYS_LIST } = require("../lib/knowledgeBase/statisticsComputer");
const { getAssetStatistics, upsertAssetStatistics, METRICS } = require("../lib/knowledgeBase/assetStatisticsStore");
const { buildAllFeatures } = require("../lib/featureBuilder");

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      positional.push(arg);
      continue;
    }
    const [, key, value] = match;
    flags[key] = value;
  }
  return { flags, positional };
}

function splitCsv(value) {
  if (!value) return undefined;
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function parseJsonFlag(value, flagName) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.error(`❌ --${flagName} precisa ser JSON válido: ${err.message}`);
    process.exit(1);
  }
}

function cmdShow(db, symbol) {
  if (!symbol) {
    console.error("uso: npm run knowledge-base -- show <symbol>");
    process.exit(1);
  }

  const asset = getAsset(db, symbol);
  console.log(`\n=== Asset: ${symbol} ===`);
  console.log(asset ? JSON.stringify(asset, null, 2) : "(sem registro -- use 'set' pra criar)");

  console.log(`\n=== Contextos resolvidos (Knowledge Resolver + Signals) ===`);
  for (const [label, build] of [
    ["StructureContext", buildStructureContext],
    ["LiquidityContext", buildLiquidityContext],
    ["FvgContext", buildFvgContext],
    ["OrderBlockContext", buildOrderBlockContext],
  ]) {
    const envelope = build(db, symbol);
    console.log(`${label}: ${JSON.stringify(envelope.context)} (source=${envelope.source}, confidence=${envelope.confidence}, knowledgeVersion=${envelope.knowledgeVersion})`);
  }

  console.log(`\n=== Knowledge Consumers ===`);
  console.log("Real (verificável hoje):");
  for (const row of REAL) console.log(`  - ${row.field} -> ${row.consumer} (${row.via})`);
  console.log("Future (documentado, não conectado ainda):");
  for (const row of FUTURE) console.log(`  - ${row.field} -> ${row.consumer} [${row.status}]`);

  console.log(`\n=== Asset Statistics ===`);
  const availableWindows = db.prepare(`SELECT window_days FROM asset_statistics_window WHERE symbol = ? AND statistics_scope = 'global' ORDER BY window_days ASC`).all(symbol);
  if (availableWindows.length === 0) {
    console.log("(nenhuma estatística computada ainda -- use 'compute-statistics')");
  } else {
    for (const { window_days: windowDays } of availableWindows) {
      const stats = getAssetStatistics(db, symbol, "global", windowDays);
      console.log(`\n-- janela ${windowDays}d (coverage=${stats.window.coverage_pct}%, freshness=${stats.window.freshness_score}, confidence=${stats.window.confidence}) --`);
      for (const metric of METRICS) {
        const m = stats.metrics[metric];
        if (!m) continue;
        console.log(
          `  ${metric}: avg=${m.avg} p50=${m.p50} p95=${m.p95} zscore=${m.zscore_current} percentile=${m.percentile_current} trend=${m.trend} drift=${m.drift_pct}% quality=${m.quality} (n=${m.sample_size})`
        );
      }
    }
  }

  console.log(`\n=== Features (Feature Builder -- não conectado a nenhum Brain) ===`);
  const featuresByDomain = buildAllFeatures(db, symbol);
  for (const [domain, features] of Object.entries(featuresByDomain)) {
    console.log(`-- ${domain} --`);
    for (const f of features) {
      console.log(`  ${f.feature} [${f.id}] v${f.version}: ${f.interpretation.state} (${f.interpretation.direction}) -- strength=${f.strength} confidence=${f.confidence}`);
    }
  }
}

function cmdComputeStatistics(db, symbol, flags) {
  if (!symbol) {
    console.error("uso: npm run knowledge-base -- compute-statistics <symbol> [--windowDays=7,30,90,180,365,730] [--scope=global]");
    process.exit(1);
  }

  const windowDaysList = flags.windowDays ? splitCsv(flags.windowDays).map(Number) : DEFAULT_WINDOW_DAYS_LIST;
  const scope = flags.scope || "global";

  const result = computeAssetStatistics(db, symbol, { scope, windowDaysList });
  for (const windowDays of windowDaysList) {
    upsertAssetStatistics(db, symbol, scope, windowDays, result[windowDays]);
  }

  console.log(`✅ ${symbol} -- estatísticas computadas e salvas pra ${windowDaysList.length} janela(s): ${windowDaysList.join(", ")} dias`);
  for (const windowDays of windowDaysList) {
    const w = result[windowDays].window;
    console.log(`  janela ${windowDays}d: sample_size=${w.sampleSize} coverage=${w.coveragePct}% freshness=${w.freshnessScore} confidence=${w.confidence}`);
  }
}

function cmdSet(db, symbol, flags) {
  if (!symbol) {
    console.error("uso: npm run knowledge-base -- set <symbol> [--sector=... --narrative=... --tags=a,b --relations='[...]']");
    process.exit(1);
  }

  const fields = {
    assetId: flags.assetId,
    aliases: splitCsv(flags.aliases),
    category: flags.category,
    subCategory: flags.subCategory,
    sector: flags.sector,
    narrative: flags.narrative,
    tags: splitCsv(flags.tags),
    supply: parseJsonFlag(flags.supply, "supply"),
    officialLinks: parseJsonFlag(flags.officialLinks, "officialLinks"),
    primaryExchange: flags.primaryExchange,
    contractType: flags.contractType,
    baseAsset: flags.baseAsset,
    quoteAsset: flags.quoteAsset,
    status: flags.status,
    relations: parseJsonFlag(flags.relations, "relations"),
    origin: flags.origin,
    confidence: flags.confidence !== undefined ? Number(flags.confidence) : undefined,
    confidenceReason: flags.confidenceReason,
    confidenceSource: flags.confidenceSource,
    lastVerification: flags.lastVerification,
    verificationMethod: flags.verificationMethod,
  };

  const asset = upsertAsset(db, symbol, fields);
  console.log(`✅ ${symbol} salvo (version=${asset.version})`);
  console.log(JSON.stringify(asset, null, 2));
}

function main() {
  const [command, symbol, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const db = openDb();

  try {
    switch (command) {
      case "show":
        return cmdShow(db, symbol);
      case "set":
        return cmdSet(db, symbol, flags);
      case "compute-statistics":
        return cmdComputeStatistics(db, symbol, flags);
      default:
        console.log("uso: npm run knowledge-base -- <show|set|compute-statistics> <symbol> [flags]");
        process.exit(command ? 1 : 0);
    }
  } finally {
    db.close();
  }
}

main();

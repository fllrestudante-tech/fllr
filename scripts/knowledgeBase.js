// CLI fina sobre a Market Knowledge Base -- só chama lib/knowledgeBase/*,
// nenhuma lógica nova aqui além de parsing de argv e formatação de saída.
// Uso: npm run knowledge-base -- <show|set> <symbol> [flags]
const { openDb } = require("../lib/infra/db");
const { getAsset, upsertAsset } = require("../lib/knowledgeBase/assetStore");
const { buildStructureContext, buildLiquidityContext, buildFvgContext, buildOrderBlockContext } = require("../lib/knowledgeBase/contextBuilder");
const { REAL, FUTURE } = require("../lib/knowledgeBase/consumers");

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
      default:
        console.log("uso: npm run knowledge-base -- <show|set> <symbol> [flags]");
        process.exit(command ? 1 : 0);
    }
  } finally {
    db.close();
  }
}

main();

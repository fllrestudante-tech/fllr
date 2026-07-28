// Persistência da entidade raiz da Market Knowledge Base (migração 0011) --
// só identidade estável do ativo (setor/narrativa/categoria/relations),
// nunca parâmetro de execução de Brain (isso é lib/knowledgeBase/resolver.js).
// `version` incrementa a cada upsert (não é histórico completo -- Knowledge
// Snapshot fica pra quando existir consumidor real disso).
const TEXT_JSON_FIELDS = ["aliases", "tags", "supply", "officialLinks", "relations"];

const COLUMN_BY_FIELD = {
  assetId: "asset_id",
  aliases: "aliases",
  category: "category",
  subCategory: "sub_category",
  sector: "sector",
  narrative: "narrative",
  tags: "tags",
  supply: "supply",
  officialLinks: "official_links",
  primaryExchange: "primary_exchange",
  contractType: "contract_type",
  baseAsset: "base_asset",
  quoteAsset: "quote_asset",
  status: "status",
  relations: "relations",
  origin: "origin",
  confidence: "confidence",
  confidenceReason: "confidence_reason",
  confidenceSource: "confidence_source",
  lastVerification: "last_verification",
  verificationMethod: "verification_method",
};

function rowToAsset(row) {
  if (!row) return null;
  const asset = { symbol: row.symbol, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, firstSeen: row.first_seen, lastSeen: row.last_seen };
  for (const [field, column] of Object.entries(COLUMN_BY_FIELD)) {
    const raw = row[column];
    asset[field] = TEXT_JSON_FIELDS.includes(field) && raw != null ? JSON.parse(raw) : raw;
  }
  return asset;
}

function getAsset(db, symbol) {
  const row = db.prepare("SELECT * FROM asset WHERE symbol = ?").get(symbol);
  return rowToAsset(row);
}

/**
 * Cria ou atualiza a linha de `symbol` -- campos não passados em `fields`
 * preservam o valor já gravado (mesmo espírito de merge parcial de
 * `scripts/registry.js add`), nunca são zerados por omissão. `version`
 * começa em 1 na criação, incrementa em cada update subsequente.
 * `origin`/`confidence` só ganham default ('manual'/100) na criação --
 * um update que não menciona proveniência não sobrescreve a já gravada.
 */
function upsertAsset(db, symbol, fields = {}, { now = () => new Date().toISOString() } = {}) {
  const timestamp = now();
  const params = { symbol, createdAt: timestamp, updatedAt: timestamp, firstSeen: timestamp, lastSeen: timestamp };
  for (const [field, column] of Object.entries(COLUMN_BY_FIELD)) {
    const value = fields[field];
    if (value === undefined) {
      params[column] = null;
      continue;
    }
    params[column] = TEXT_JSON_FIELDS.includes(field) ? JSON.stringify(value) : value;
  }

  // Nota: a cláusula DO UPDATE abaixo referencia os parâmetros nomeados
  // (@origin/@confidence) diretamente, não `excluded.*` -- se usássemos
  // `excluded.origin` ali, ele refletiria o valor JÁ COALESCIDO da cláusula
  // VALUES (sempre 'manual' quando @origin é null), quebrando a promessa
  // de "update sem proveniência não sobrescreve a já gravada". Os dois
  // COALESCE(@campo, ...) abaixo, um em VALUES (default de criação) e outro
  // em DO UPDATE (preserva o valor já gravado), resolvem propósitos
  // diferentes com o mesmo parâmetro cru.
  db.prepare(
    `INSERT INTO asset (
       symbol, asset_id, aliases, category, sub_category, sector, narrative, tags, supply,
       official_links, primary_exchange, contract_type, base_asset, quote_asset, status, relations,
       origin, confidence, confidence_reason, confidence_source, last_verification, verification_method,
       version, first_seen, last_seen, created_at, updated_at
     ) VALUES (
       @symbol, @asset_id, @aliases, @category, @sub_category, @sector, @narrative, @tags, @supply,
       @official_links, @primary_exchange, @contract_type, @base_asset, @quote_asset, @status, @relations,
       COALESCE(@origin, 'manual'), COALESCE(@confidence, 100), @confidence_reason, @confidence_source, @last_verification, @verification_method,
       1, @firstSeen, @lastSeen, @createdAt, @updatedAt
     )
     ON CONFLICT(symbol) DO UPDATE SET
       asset_id = COALESCE(excluded.asset_id, asset.asset_id),
       aliases = COALESCE(excluded.aliases, asset.aliases),
       category = COALESCE(excluded.category, asset.category),
       sub_category = COALESCE(excluded.sub_category, asset.sub_category),
       sector = COALESCE(excluded.sector, asset.sector),
       narrative = COALESCE(excluded.narrative, asset.narrative),
       tags = COALESCE(excluded.tags, asset.tags),
       supply = COALESCE(excluded.supply, asset.supply),
       official_links = COALESCE(excluded.official_links, asset.official_links),
       primary_exchange = COALESCE(excluded.primary_exchange, asset.primary_exchange),
       contract_type = COALESCE(excluded.contract_type, asset.contract_type),
       base_asset = COALESCE(excluded.base_asset, asset.base_asset),
       quote_asset = COALESCE(excluded.quote_asset, asset.quote_asset),
       status = COALESCE(excluded.status, asset.status),
       relations = COALESCE(excluded.relations, asset.relations),
       origin = COALESCE(@origin, asset.origin),
       confidence = COALESCE(@confidence, asset.confidence),
       confidence_reason = COALESCE(excluded.confidence_reason, asset.confidence_reason),
       confidence_source = COALESCE(excluded.confidence_source, asset.confidence_source),
       last_verification = COALESCE(excluded.last_verification, asset.last_verification),
       verification_method = COALESCE(excluded.verification_method, asset.verification_method),
       version = asset.version + 1,
       last_seen = excluded.last_seen,
       updated_at = excluded.updated_at`
  ).run(params);

  return getAsset(db, symbol);
}

module.exports = { getAsset, upsertAsset };

// Amostra a saúde do market.db via PRAGMAs de baixo custo, numa conexão
// read-only própria -- nunca compete por lock com os coletores escrevendo em
// WAL. `integrity_check` é um scan O(n) do banco inteiro, então só roda
// quando `runIntegrityCheck:true` (o metrics sampler chama isso num
// intervalo bem mais lento que o resto, não a cada tick).
const fs = require("fs");
const Database = require("better-sqlite3");
const { DEFAULT_DB_PATH } = require("./infra/db");

const FRAGMENTATION_VACUUM_THRESHOLD = 0.2; // freelist_count/page_count acima disso sinaliza VACUUM -- valor inicial, calibrar depois de observar o banco real

/**
 * page_count=0 (banco vazio/recém-criado) não é fragmentação -- freelist não
 * tem como superar um total de zero páginas.
 */
function classifyFragmentation(freelistCount, pageCount) {
  if (!pageCount || pageCount <= 0) {
    return { fragmentationRatio: 0, vacuumNeeded: false };
  }
  const fragmentationRatio = freelistCount / pageCount;
  return { fragmentationRatio, vacuumNeeded: fragmentationRatio > FRAGMENTATION_VACUUM_THRESHOLD };
}

function sampleDatabaseHealth(dbPath = DEFAULT_DB_PATH, { runIntegrityCheck = true } = {}) {
  if (!fs.existsSync(dbPath)) {
    return { status: "not_implemented", reason: "market.db ainda não existe (nenhum coletor rodou ainda)" };
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const sizeBytes = fs.statSync(dbPath).size;
    const pageCount = db.pragma("page_count", { simple: true });
    const freelistCount = db.pragma("freelist_count", { simple: true });
    const { fragmentationRatio, vacuumNeeded } = classifyFragmentation(freelistCount, pageCount);

    let integrity = null;
    if (runIntegrityCheck) {
      const rows = db.pragma("integrity_check");
      const ok = rows.length === 1 && rows[0].integrity_check === "ok";
      integrity = { ok, detail: ok ? "ok" : rows.map((r) => r.integrity_check).join("; ") };
    }

    return {
      status: integrity && !integrity.ok ? "down" : "ok",
      sizeBytes,
      pageCount,
      freelistCount,
      fragmentationRatio,
      vacuumNeeded,
      integrity,
      sampledAt: new Date().toISOString(),
    };
  } catch (err) {
    return { status: "down", error: err.message };
  } finally {
    if (db) db.close();
  }
}

module.exports = { classifyFragmentation, sampleDatabaseHealth, FRAGMENTATION_VACUUM_THRESHOLD };

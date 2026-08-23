// Extrai o padrão `new Database(path, {readonly:true, fileMustExist:true})`
// + try/catch/finally que hoje se repete várias vezes dentro de
// scripts/health.js (readAvailability, readMarketBrainSnapshot, etc.) --
// usado pelos readers do Dashboard Operacional (Fase A+1) pra nunca abrir
// conexão de escrita por engano.
const fs = require("fs");
const Database = require("better-sqlite3");

/**
 * Se o arquivo não existe, devolve `fallback` sem tentar abrir nada. Se
 * `fn(db)` lançar, devolve `fallback` também -- mesmo comportamento honesto
 * de "não travar a seção inteira por causa de 1 leitura" já usado em
 * scripts/health.js.
 */
function withReadonlyDb(dbPath, fn, fallback = null) {
  if (!fs.existsSync(dbPath)) return fallback;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    if (db) db.close();
  }
}

module.exports = { withReadonlyDb };

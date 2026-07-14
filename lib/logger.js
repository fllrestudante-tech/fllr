const fs = require("fs");
const config = require("../config");

const SCHEMA_VERSION = 1;

function ensureDataDir() {
  if (!fs.existsSync(config.paths.dataDir)) {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
  }
}

/**
 * Log estruturado, uma linha JSON por evento (JSONL).
 * schemaVersion fixo resolve o bug do CSV antigo: o header do trades.csv
 * mudava entre versões do script sem migrar as linhas já gravadas, então
 * colunas antigas e novas ficavam misturadas no mesmo arquivo e viravam
 * lixo (ex: as 194 linhas "EXECUTED" tinham preço 0 e campos undefined).
 * Aqui cada evento carrega o próprio schemaVersion, então mudanças futuras
 * de formato não corrompem o histórico anterior.
 */
function log(event) {
  ensureDataDir();
  const line = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    time: new Date().toISOString(),
    ...event,
  });
  fs.appendFileSync(config.paths.tradesLog, line + "\n");
}

module.exports = { log };

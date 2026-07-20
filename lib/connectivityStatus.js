// Lado de LEITURA do Connectivity Manager -- usado por todo processo que não
// é o supervisor (bot, cada coletor). Só lê o snapshot que o supervisor
// publica em runtime/connectivity/status.json; nunca sonda rede por conta
// própria. É a "pergunta simples" (`isOnline()`/`isProviderHealthy()`) que
// substitui cada módulo reinventando sua própria lógica de detecção.
const fs = require("fs");
const path = require("path");

const DEFAULT_STATUS_FILE = path.join(__dirname, "..", "runtime", "connectivity", "status.json");

function readStatus(filePath = DEFAULT_STATUS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // arquivo ainda não existe (supervisor não rodou o primeiro tick) ou
    // está sendo escrito nesse instante -- "sem informação", não "offline".
    return null;
  }
}

// Falha aberto (assume online) na ausência de dado -- evita que um boot
// antes do primeiro tick do supervisor trave bot/coletores esperando um
// arquivo que ainda não existe (mesmo espírito do estado STARTING em
// lib/operationalState.js: sem dado ainda não é a mesma coisa que ERROR).
function isOnline(filePath = DEFAULT_STATUS_FILE) {
  const status = readStatus(filePath);
  if (!status) return true;
  return status.online !== false;
}

function isProviderHealthy(name, filePath = DEFAULT_STATUS_FILE) {
  const status = readStatus(filePath);
  if (!status || !status.providers) return true;
  return status.providers[name] !== false;
}

function getStatus(filePath = DEFAULT_STATUS_FILE) {
  return readStatus(filePath);
}

module.exports = { readStatus, isOnline, isProviderHealthy, getStatus, DEFAULT_STATUS_FILE };

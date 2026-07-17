// Escreve um snapshot JSON em disco periodicamente -- é como qualquer
// processo de longa duração (coletor, metrics sampler) avisa "estou vivo e
// aqui está meu estado" pra quem checa de fora (npm run health, index.js).
// Extraído do padrão que os 4 scripts de coletor duplicavam (setTimeout do
// primeiro write + setInterval dos seguintes); `getPayload` é só uma função
// callback, não um objeto "coletor", pra também servir o metrics sampler
// (que não tem um `collector.getMetrics()`).
const fs = require("fs");
const path = require("path");

function writeJsonSnapshot(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

/**
 * `initialDelayMs` existe pra dar tempo do primeiro ciclo de coleta (disparado
 * no boot, assíncrono) terminar antes do primeiro write -- senão o heartbeat
 * sai sempre vazio na primeira leitura.
 */
function startHeartbeat(filePath, getPayload, { intervalMs = 60000, initialDelayMs = 5000 } = {}) {
  function write() {
    writeJsonSnapshot(filePath, { lastHeartbeatAt: new Date().toISOString(), ...getPayload() });
  }

  const initialTimer = setTimeout(write, initialDelayMs);
  const intervalTimer = setInterval(write, intervalMs);

  return {
    stop() {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
  };
}

module.exports = { writeJsonSnapshot, startHeartbeat };

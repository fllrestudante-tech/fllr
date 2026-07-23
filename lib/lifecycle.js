// Detecta se o supervisor foi reiniciado de propósito (Ctrl-C, taskkill
// gracioso) ou depois de uma queda inesperada (crash do processo, reboot do
// SO, falta de energia) -- runtime/processes/state.json não serve pra isso
// porque ele só descreve os FILHOS, não o próprio supervisor, e não distingue
// "saí de propósito" de "morri no meio". runtime/lifecycle.json guarda um
// único registro simples: {status, bootId, pid, startedAt, lastHeartbeatAt}.
// status:"running" nunca é sobrescrito por este próprio processo em condição
// normal -- só vira "clean_shutdown" no shutdown() do supervisor. Se o
// próximo boot encontrar "running" ainda lá, é prova de que o processo
// anterior nunca chegou a se despedir.
const path = require("path");
const crypto = require("crypto");
const { atomicWriteJsonSync } = require("./atomicWrite");

function readLifecycle(filePath, { fsImpl = require("fs") } = {}) {
  try {
    if (!fsImpl.existsSync(filePath)) return null;
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    // Arquivo corrompido (ex: escrita não-atômica interrompida antes desta
    // fase existir) não deve travar o boot -- trata como "sem histórico".
    return null;
  }
}

function writeRunning(filePath, { bootId = crypto.randomUUID(), pid, startedAt }) {
  const record = { status: "running", bootId, pid, startedAt, lastHeartbeatAt: startedAt };
  atomicWriteJsonSync(filePath, record);
  return record;
}

function writeHeartbeat(filePath, previous, now) {
  const record = { ...previous, lastHeartbeatAt: new Date(now).toISOString() };
  atomicWriteJsonSync(filePath, record);
  return record;
}

function writeCleanShutdown(filePath, previous, now) {
  const record = { ...previous, status: "clean_shutdown", lastHeartbeatAt: new Date(now).toISOString() };
  atomicWriteJsonSync(filePath, record);
  return record;
}

/**
 * Pura, sem I/O. `previous` é o que veio de readLifecycle() (ou null na
 * primeira execução de sempre). Distingue duas causas quando há incidente:
 * - os_reboot: o SO ligou (now - osUptimeSec*1000) DEPOIS do último heartbeat
 *   conhecido -- o próprio SO reiniciou desde a última prova de vida.
 * - process_crash: o SO seguiu ligado o tempo todo -- só o processo do
 *   supervisor morreu (taskkill /F, logoff derrubando a tarefa agendada,
 *   etc.), sem reboot de verdade.
 * `startedAt`/`endedAt` do incidente usam o ÚLTIMO HEARTBEAT conhecido como
 * início (não sabemos o segundo exato da morte, só a última prova de vida --
 * mesma honestidade já aplicada a outras métricas do projeto: nunca fabricar
 * um valor mais preciso do que o dado real permite).
 */
function detectBootIncident({ previous, osUptimeSec, now }) {
  if (!previous || previous.status === "clean_shutdown") {
    return { isIncident: false };
  }

  const osBootedAt = now - osUptimeSec * 1000;
  const lastHeartbeatAt = new Date(previous.lastHeartbeatAt).getTime();
  const rootCause = osBootedAt > lastHeartbeatAt ? "os_reboot" : "process_crash";

  return { isIncident: true, rootCause, startedAt: lastHeartbeatAt, endedAt: now };
}

function defaultLifecyclePath(runtimeDir) {
  return path.join(runtimeDir, "lifecycle.json");
}

module.exports = { readLifecycle, writeRunning, writeHeartbeat, writeCleanShutdown, detectBootIncident, defaultLifecyclePath };

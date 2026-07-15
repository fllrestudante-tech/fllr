// Estado puro do supervisor de processos -- sem child_process, sem timers,
// sem fs. A mesma lógica de restart/backoff que scripts/watchdog.js já usava
// pra supervisionar só o index.js, generalizada pra N processos (bot + os 4
// coletores), cada um com seu próprio contador de falhas consecutivas.
// scripts/supervisor.js é quem chama essas funções e decide o que fazer com
// o retorno (spawn de verdade, setTimeout, gravar em disco).
const { nextLoopDelay } = require("./backoff");

const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 300000; // teto de 5min entre reinícios
const MIN_UPTIME_TO_RESET_MS = 60000; // ficou de pé por >1min = saudável, zera o contador de falhas

function createSupervisorState(childNames) {
  const state = {};
  for (const name of childNames) {
    state[name] = {
      pid: null,
      status: "stopped",
      startedAt: null,
      consecutiveRestarts: 0,
      totalRestarts: 0,
      lastExit: null,
    };
  }
  state._meta = { lastTickAt: null };
  return state;
}

function recordSpawn(state, name, pid, now = Date.now()) {
  state[name] = {
    ...state[name],
    pid,
    status: "running",
    startedAt: new Date(now).toISOString(),
  };
  return state[name];
}

/**
 * Chamado quando um filho morre e o supervisor pretende reiniciá-lo (crash,
 * não desligamento pedido). Reseta consecutiveRestarts se o processo ficou
 * de pé tempo suficiente (>= MIN_UPTIME_TO_RESET_MS); senão incrementa, o que
 * aumenta o backoff exponencial via nextLoopDelay (lib/backoff.js).
 */
function recordExit(state, name, { code = null, signal = null } = {}, now = Date.now()) {
  const prev = state[name];
  const startedAtMs = prev.startedAt ? new Date(prev.startedAt).getTime() : now;
  const uptimeMs = now - startedAtMs;
  const consecutiveRestarts = uptimeMs >= MIN_UPTIME_TO_RESET_MS ? 0 : prev.consecutiveRestarts + 1;
  const totalRestarts = prev.totalRestarts + 1;
  const delayMs = nextLoopDelay(consecutiveRestarts, BASE_DELAY_MS, MAX_DELAY_MS);

  state[name] = {
    ...prev,
    pid: null,
    status: "crashed",
    consecutiveRestarts,
    totalRestarts,
    lastExit: { code, signal, at: new Date(now).toISOString(), uptimeMs },
  };

  return { delayMs, consecutiveRestarts, totalRestarts, uptimeMs };
}

/**
 * Desligamento pedido (SIGINT/SIGTERM propagado pelo supervisor) -- não é
 * crash, não mexe em consecutiveRestarts/totalRestarts nem agenda reinício.
 */
function markStopped(state, name, now = Date.now()) {
  const prev = state[name];
  const startedAtMs = prev.startedAt ? new Date(prev.startedAt).getTime() : now;
  state[name] = {
    ...prev,
    pid: null,
    status: "stopped",
    lastExit: { code: 0, signal: "SIGINT", at: new Date(now).toISOString(), uptimeMs: now - startedAtMs },
  };
  return state[name];
}

function touchTick(state, now = Date.now()) {
  state._meta = { lastTickAt: new Date(now).toISOString() };
  return state._meta;
}

module.exports = {
  createSupervisorState,
  recordSpawn,
  recordExit,
  markStopped,
  touchTick,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MIN_UPTIME_TO_RESET_MS,
};

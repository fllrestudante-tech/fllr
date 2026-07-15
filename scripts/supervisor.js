// Supervisiona o bot principal + os 4 coletores como processos filhos,
// reiniciando automaticamente quem cair (crash, terminal fechado, sleep da
// máquina) com backoff exponencial -- generaliza o antigo scripts/watchdog.js
// (que só cuidava de index.js) pra todos os processos de longa duração do
// projeto. Toda a lógica de estado/backoff fica em lib/supervisor.js (puro,
// testável); este arquivo só faz a ligação com child_process/fs de verdade.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createSupervisorState, recordSpawn, recordExit, markStopped, touchTick } = require("../lib/supervisor");

const RUNTIME_DIR = path.join(__dirname, "..", "runtime");
const LOCK_FILE = path.join(RUNTIME_DIR, "locks", "supervisor.lock");
const PIDS_DIR = path.join(RUNTIME_DIR, "pids");
const STATE_FILE = path.join(RUNTIME_DIR, "processes", "state.json");
const TICK_INTERVAL_MS = 30000;

const CHILDREN = [
  { name: "bot", script: path.join(__dirname, "..", "index.js") },
  { name: "bybit_collector", script: path.join(__dirname, "collector.js") },
  { name: "fear_greed_collector", script: path.join(__dirname, "fearGreedCollector.js") },
  { name: "btc_dominance_collector", script: path.join(__dirname, "btcDominanceCollector.js") },
  { name: "knowledge_collector", script: path.join(__dirname, "knowledgeCollector.js") },
];

function ensureDirs() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  fs.mkdirSync(PIDS_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Impede subir 2 supervisores (e portanto 2 bots) ao mesmo tempo -- risco
// real de ordens duplicadas na Bybit, não só desperdício de recursos.
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (isPidAlive(raw.pid)) {
      console.error(`🔒 Já existe um supervisor rodando (PID ${raw.pid}, iniciado em ${raw.startedAt}). Encerrando.`);
      process.exit(1);
    }
    console.warn(`🔒 Lock encontrado de um processo morto (PID ${raw.pid}) -- assumindo.`);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

function releaseLock() {
  fs.rmSync(LOCK_FILE, { force: true });
}

function pidFile(name) {
  return path.join(PIDS_DIR, `${name}.pid`);
}

const state = createSupervisorState(CHILDREN.map((c) => c.name));
const restartTimers = {};
let shuttingDown = false;
let tickTimer = null;

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function startChild(spec) {
  if (shuttingDown) return;
  console.log(`🐕 Supervisor iniciando ${spec.name} (tentativa ${state[spec.name].totalRestarts + 1})...`);
  // stdio:"inherit" mantido por enquanto -- redirecionar pra logs rotacionados é Fase B (Observability).
  const child = spawn(process.execPath, [spec.script], { stdio: "inherit" });

  recordSpawn(state, spec.name, child.pid, Date.now());
  fs.writeFileSync(pidFile(spec.name), String(child.pid));
  persistState();

  child.on("exit", (code, signal) => {
    fs.rmSync(pidFile(spec.name), { force: true });

    if (shuttingDown) {
      markStopped(state, spec.name, Date.now());
      persistState();
      return;
    }

    const { delayMs, consecutiveRestarts } = recordExit(state, spec.name, { code, signal }, Date.now());
    persistState();
    console.warn(
      `🐕 ${spec.name} encerrou (code=${code} signal=${signal}, falhas seguidas=${consecutiveRestarts}). Reiniciando em ${Math.round(delayMs / 1000)}s...`
    );
    restartTimers[spec.name] = setTimeout(() => startChild(spec), delayMs);
  });

  child.on("error", (err) => {
    console.error(`🐕 Falha ao iniciar ${spec.name}:`, err.message);
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🐕 Supervisor encerrando (${signal})...`);
  for (const timer of Object.values(restartTimers)) clearTimeout(timer);
  if (tickTimer) clearInterval(tickTimer);

  // No Windows não existe entrega real de SIGINT/SIGTERM entre processos
  // não relacionados -- process.kill(pid,"SIGINT") aqui encerra o filho na
  // hora (equivalente a um SIGKILL), sem rodar o handler de SIGINT dele.
  // Seguro pra este projeto: coletores não têm transação em aberto entre
  // ciclos (better-sqlite3 é síncrono/WAL). Em SO com sinais reais isso
  // também dispara o handler de SIGINT de cada script normalmente.
  for (const spec of CHILDREN) {
    const pid = state[spec.name].pid;
    if (pid) {
      try {
        process.kill(pid, "SIGINT");
      } catch {
        // já tinha morrido sozinho, nada a fazer
      }
    }
  }

  releaseLock();
  setTimeout(() => process.exit(0), 500); // dá um instante pros children saírem antes de soltar o terminal
}

ensureDirs();
acquireLock();
for (const spec of CHILDREN) startChild(spec);

tickTimer = setInterval(() => {
  touchTick(state, Date.now());
  persistState();
}, TICK_INTERVAL_MS);

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("🐕 Supervisor: exceção não tratada (ignorada, supervisor continua vivo):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("🐕 Supervisor: rejeição não tratada (ignorada, supervisor continua vivo):", err);
});

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
const { createRotatingWriter } = require("../lib/logRotation");
const { openDb, insertEvent } = require("../lib/infra/db");
const { createEventBus } = require("../lib/infra/eventBus");
const { createAlertManager } = require("../lib/alertManager");
const { atomicWriteJsonSync } = require("../lib/atomicWrite");
const connectivityManager = require("../lib/connectivityManager");
const connectivityStatus = require("../lib/connectivityStatus");
const systemIncidents = require("../lib/systemIncidents");
const backfill = require("../lib/backfill");
const { sendTelegramAlert } = require("../lib/alerts");
const { insertAlertHistory } = require("../lib/alertsHistory");
const { getSla } = require("../lib/slaRegistry");
const { sampleDatabaseHealth } = require("../lib/databaseHealth");
const bybitClient = require("../lib/bybit");
const config = require("../config");

const RUNTIME_DIR = path.join(__dirname, "..", "runtime");
const LOCK_FILE = path.join(RUNTIME_DIR, "locks", "supervisor.lock");
const PIDS_DIR = path.join(RUNTIME_DIR, "pids");
const STATE_FILE = path.join(RUNTIME_DIR, "processes", "state.json");
const CONNECTIVITY_STATUS_FILE = connectivityStatus.DEFAULT_STATUS_FILE;
const TICK_INTERVAL_MS = 30000;
const INCIDENT_TYPE = "NETWORK";

const CHILDREN = [
  { name: "bot", script: path.join(__dirname, "..", "index.js") },
  { name: "bybit_collector", script: path.join(__dirname, "collector.js") },
  { name: "fear_greed_collector", script: path.join(__dirname, "fearGreedCollector.js") },
  { name: "btc_dominance_collector", script: path.join(__dirname, "btcDominanceCollector.js") },
  { name: "knowledge_collector", script: path.join(__dirname, "knowledgeCollector.js") },
  { name: "metrics_sampler", script: path.join(__dirname, "metricsSampler.js") },
  { name: "backup_daemon", script: path.join(__dirname, "backupDaemon.js") },
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

// Um writer por nome de filho, reaproveitado entre reinícios do mesmo
// processo -- não recria o arquivo a cada restart, só continua escrevendo
// (cada restart já fica registrado como uma linha "encerrou/reiniciando").
const logWriters = Object.fromEntries(CHILDREN.map((c) => [c.name, createRotatingWriter(c.name)]));

// Conexão própria (mesmo padrão de todo processo já supervisionado) só pra
// alertas: grava em events_log (via eventBus) e em alerts_history (via
// alertManager) -- não lê/escreve nada do Market Database em si.
const db = openDb();
const eventBus = createEventBus({ persist: (event) => insertEvent(db, event) });
const alertManager = createAlertManager({ db });

// Connectivity Manager -- roda só aqui (o supervisor é o único processo que
// já tickava e centraliza eventBus/db/alertas), publica um snapshot em
// runtime/connectivity/status.json que bot/coletores só leem (ver
// lib/connectivityStatus.js), nunca sondam rede por conta própria.
const connectivityMonitor = connectivityManager.createConnectivityMonitor();
let openIncidentUuid = null;

// Cobre o supervisor ter sido reiniciado no meio de um incidente ainda
// aberto -- sem isso, um monitor recém-criado "esqueceria" o incidente e
// nunca dispararia o alerta de resolução quando a conexão voltasse.
const resumedIncident = systemIncidents.queryOpenIncident(db, INCIDENT_TYPE);
if (resumedIncident) {
  connectivityMonitor.resumeIncident(resumedIncident);
  openIncidentUuid = resumedIncident.uuid;
  console.warn(`🔌 Incidente de rede já aberto retomado (causa=${resumedIncident.root_cause}, desde ${resumedIncident.started_at}).`);
}

function persistState() {
  atomicWriteJsonSync(STATE_FILE, state);
}

async function resyncAfterIncident(incident) {
  const opts = { exchange: "bybit", symbol: config.symbol, interval: config.interval, sinceMs: incident.startedAt, untilMs: incident.endedAt };
  const results = {};
  try {
    const [candles, funding, openInterest] = await Promise.all([
      backfill.backfillCandles(db, eventBus, bybitClient, opts),
      backfill.backfillFunding(db, eventBus, bybitClient, opts),
      backfill.backfillOpenInterest(db, eventBus, bybitClient, opts),
    ]);
    const durationMs = incident.endedAt - incident.startedAt;
    for (const [domain, result] of [["candles", candles], ["funding", funding], ["openInterest", openInterest]]) {
      const expected = Math.max(0, Math.round(durationMs / getSla(domain === "openInterest" ? "open_interest" : domain).expectedIntervalMs));
      results[domain] = { expectedMissing: expected, recovered: result.inserted };
    }
    systemIncidents.updateResyncStatus(db, openIncidentUuid, { resyncStatus: "done", resyncDetails: results });
  } catch (err) {
    console.error("🔌 Falha ao recuperar dados perdidos durante o incidente:", err.message);
    systemIncidents.updateResyncStatus(db, openIncidentUuid, { resyncStatus: "failed", resyncDetails: { error: err.message } });
  }
  return results;
}

function summarizeResync(results) {
  return Object.entries(results)
    .map(([domain, r]) => `${domain}: ${r.recovered}/${r.expectedMissing}`)
    .join(", ");
}

async function runConnectivityCheck() {
  const [internetOk, bybitRes, coingeckoRes, telegramRes] = await Promise.all([
    connectivityManager.checkInternetReachable(),
    connectivityManager.checkBybitHealth(),
    connectivityManager.checkCoinGeckoHealth(),
    connectivityManager.checkTelegramHealth(),
  ]);
  const providerErrors = { bybit: bybitRes.error, coingecko: coingeckoRes.error, telegram: telegramRes.error };
  const status = connectivityManager.classifyConnectivity({ internetOk, providerErrors });
  const dbHealth = sampleDatabaseHealth(undefined, { runIntegrityCheck: false });

  const { action, incident } = connectivityMonitor.recordCheck(status);

  atomicWriteJsonSync(CONNECTIVITY_STATUS_FILE, {
    online: status === "ok",
    reason: status === "ok" ? null : status,
    since: connectivityMonitor.getOpenIncident()?.startedAt ?? null,
    providers: { bybit: bybitRes.ok, coingecko: coingeckoRes.ok, telegram: telegramRes.ok || !!telegramRes.skipped, database: dbHealth.status !== "down" },
    updatedAt: new Date().toISOString(),
  });

  if (action === "open") {
    const severity = connectivityManager.severityForReason(incident.reason);
    openIncidentUuid = systemIncidents.insertOpenIncident(db, { type: INCIDENT_TYPE, severity, rootCause: incident.reason, startedAt: incident.startedAt });
    eventBus.emit("connectivity.lost", { incidentUuid: openIncidentUuid, reason: incident.reason });
    console.warn(`🔌 Conectividade perdida (causa=${incident.reason}).`);
  } else if (action === "close") {
    systemIncidents.closeIncident(db, openIncidentUuid, { endedAt: incident.endedAt, durationMs: incident.durationMs, automaticRecovery: true });
    eventBus.emit("connectivity.restored", { incidentUuid: openIncidentUuid, reason: incident.reason, durationMs: incident.durationMs });

    const results = await resyncAfterIncident(incident);
    const message = connectivityManager.formatIncidentMessage(incident, { resyncSummary: summarizeResync(results) });
    console.log(`🔌 ${message}`);
    await sendTelegramAlert(message).catch((err) => console.error("🔌 Falha ao enviar alerta de conectividade:", err.message));
    insertAlertHistory(db, { severity: connectivityManager.severityForReason(incident.reason), source: "connectivity", message, occurredAt: new Date().toISOString() });

    openIncidentUuid = null;
  }
}

function startChild(spec) {
  if (shuttingDown) return;
  console.log(`🐕 Supervisor iniciando ${spec.name} (tentativa ${state[spec.name].totalRestarts + 1})...`);
  // stdout/stderr vão pro terminal (tee, visibilidade imediata) E pro log
  // rotacionado do dia (persistência real -- antes, com stdio:"inherit",
  // fechar o terminal perdia tudo). Um arquivo por componente por dia, sem
  // separar stdout/stderr -- é a informação mais simples que resolve o
  // problema de verdade.
  const child = spawn(process.execPath, [spec.script], { stdio: ["ignore", "pipe", "pipe"] });
  const logWriter = logWriters[spec.name];
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    logWriter.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    logWriter.write(chunk);
  });

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
    // 5+ falhas seguidas sem conseguir ficar de pé (uptime < 60s cada vez) é
    // sinal de algo mais sério que uma queda isolada -- CRITICAL em vez de
    // ERROR. O alertManager já deduplica sozinho se isso continuar batendo.
    const severity = consecutiveRestarts >= 5 ? "CRITICAL" : "ERROR";
    alertManager.fire(spec.name, severity, `${spec.name} caiu (code=${code} signal=${signal})`).catch((err) => {
      console.error("🐕 Falha ao disparar alerta:", err.message);
    });
    eventBus.emit("supervisor.child_crashed", { name: spec.name, code, signal, consecutiveRestarts });
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
  setTimeout(() => {
    for (const writer of Object.values(logWriters)) writer.close();
    db.close();
    process.exit(0);
  }, 500); // dá um instante pros children saírem antes de soltar o terminal
}

ensureDirs();
acquireLock();
for (const spec of CHILDREN) startChild(spec);

tickTimer = setInterval(() => {
  touchTick(state, Date.now());
  persistState();
  alertManager.flush().catch((err) => console.error("🐕 Falha ao consolidar alertas:", err.message));
  runConnectivityCheck().catch((err) => console.error("🔌 Falha na checagem de conectividade:", err.message));
}, TICK_INTERVAL_MS);
runConnectivityCheck().catch((err) => console.error("🔌 Falha na checagem de conectividade:", err.message)); // primeira checagem já no boot, sem esperar o 1º tick

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("🐕 Supervisor: exceção não tratada (ignorada, supervisor continua vivo):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("🐕 Supervisor: rejeição não tratada (ignorada, supervisor continua vivo):", err);
});

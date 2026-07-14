// Supervisiona index.js como processo filho e reinicia automaticamente se ele
// morrer por qualquer motivo (crash não tratado, terminal fechado, sleep da
// máquina, etc.) — sem isso o bot depende de alguém deixar o terminal aberto
// pra sempre. Backoff evita tempestade de reinícios se o processo cair
// repetidamente logo na largada.
const { spawn } = require("child_process");
const path = require("path");
const logger = require("../lib/logger");
const { nextLoopDelay } = require("../lib/backoff");

const BASE_DELAY_MS = 5000;
const MAX_DELAY_MS = 300000; // teto de 5min entre reinícios
const MIN_UPTIME_TO_RESET_MS = 60000; // ficou de pé por >1min = saudável, zera o contador de falhas

let consecutiveRestarts = 0;

function start() {
  const startedAt = Date.now();
  console.log(`🐕 Watchdog iniciando index.js (tentativa ${consecutiveRestarts + 1})...`);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "index.js")], { stdio: "inherit" });

  child.on("exit", (code, signal) => {
    const uptimeMs = Date.now() - startedAt;
    consecutiveRestarts = uptimeMs >= MIN_UPTIME_TO_RESET_MS ? 0 : consecutiveRestarts + 1;
    const delay = nextLoopDelay(consecutiveRestarts, BASE_DELAY_MS, MAX_DELAY_MS);

    logger.log({ event: "watchdog_restart", code, signal, uptimeMs, consecutiveRestarts, nextRestartInMs: delay });
    console.warn(
      `🐕 index.js encerrou (code=${code} signal=${signal}, uptime=${Math.round(uptimeMs / 1000)}s). Reiniciando em ${Math.round(delay / 1000)}s...`
    );
    setTimeout(start, delay);
  });

  child.on("error", (err) => {
    console.error("🐕 Falha ao iniciar processo filho:", err.message);
  });
}

process.on("SIGINT", () => {
  console.log("🐕 Watchdog encerrado (SIGINT).");
  process.exit(0);
});

start();

// Lock de reserva EXCLUSIVO entre PROCESSOS (não só entre chamadas
// assíncronas dentro de um processo) -- protege a decisão de aumento de
// exposição do perfil demo contra dois `node` distintos (dois `node
// index.js`, uma inicialização manual concorrente com a tarefa
// agendada, etc.) tentando reservar capacidade financeira ao mesmo
// tempo. Usa `fs.openSync(path, "wx")` -- a flag POSIX O_EXCL: cria o
// arquivo SE E SOMENTE SE ele ainda não existir, atomicamente a nível de
// sistema operacional (garantia do próprio SO, não do Node) -- é
// exatamente esse "cria só se não existir" que dá exclusão mútua real
// entre processos, sem precisar de nenhuma dependência nova.
//
// Lock obsoleto (processo dono já morreu, ou lock mais velho que
// `staleAfterMs`) é detectado e reclamado com segurança -- nunca herda
// silenciosamente uma reserva de um processo morto sem verificar.
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_STALE_AFTER_MS = 30_000; // uma decisão de gate nunca deveria legitimamente segurar o lock por mais que uma fração de segundo -- 30s já é uma folga generosa pra um processo travado/lento

class LockBusyError extends Error {
  constructor(lockPath) {
    super(`Lock de reserva demo ocupado por outro processo (${lockPath}) -- tentativa concorrente rejeitada, nunca ignorada silenciosamente.`);
    this.name = this.constructor.name;
    this.code = "DEMO_RESERVATION_LOCK_BUSY";
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tenta reclamar um lock que JÁ EXISTE por estar obsoleto -- só remove
 * se o PID dono está morto OU o lock é mais velho que `staleAfterMs`.
 * Corrida entre dois processos reclamando o MESMO lock obsoleto ao
 * mesmo tempo: `fs.unlinkSync` + a próxima tentativa de `wx` resolve
 * isso -- na pior das hipóteses um dos dois falha e tenta de novo
 * (nunca os dois acham que reclamaram com sucesso).
 */
function tryReclaimStaleLock(lockPath, staleAfterMs, now) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    // lock ilegível -- trata como obsoleto (não dá pra confirmar dono nem idade, mas também não dá pra confiar nele)
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* outro processo já removeu -- ok */
    }
    return;
  }
  const age = now - (info.acquiredAtMs || 0);
  const ownerDead = typeof info.pid !== "number" || !isPidAlive(info.pid);
  if (ownerDead || age > staleAfterMs) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* outro processo já removeu -- ok */
    }
  }
}

/**
 * Adquire o lock de forma síncrona, com poucas tentativas rápidas (nunca
 * espera indefinidamente -- uma reserva de ordem é uma decisão que deve
 * ser rápida; se está demorando, algo está errado e é melhor falhar
 * explícito que travar o processo chamador). Devolve um handle
 * (`{ release() }`) -- SEMPRE liberado no `finally` de quem chamou.
 */
function acquireReservationLock(lockPath, { staleAfterMs = DEFAULT_STALE_AFTER_MS, maxAttempts = 5, retryDelayMs = 20 } = {}) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx"); // O_EXCL -- atômico a nível de SO, falha com EEXIST se já existe
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), acquiredAtMs: Date.now() }));
      fs.closeSync(fd);
      return {
        release() {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* já removido -- idempotente de propósito */
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      tryReclaimStaleLock(lockPath, staleAfterMs, Date.now());
      if (attempt < maxAttempts - 1) {
        sleepSyncMs(retryDelayMs);
      }
    }
  }
  throw new LockBusyError(lockPath);
}

// Sleep SÍNCRONO curto (bloqueia o processo) -- usado só entre tentativas
// de adquirir o lock, nunca em outro lugar. Atomics.wait sobre um
// SharedArrayBuffer é o único jeito de dormir sincronamente em Node sem
// depender de nenhum pacote novo.
function sleepSyncMs(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/** Executa `fn` (síncrona) com o lock adquirido -- sempre libera, mesmo se `fn` lançar. */
function withReservationLock(lockPath, fn, opts) {
  const lock = acquireReservationLock(lockPath, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  LockBusyError,
  acquireReservationLock,
  withReservationLock,
};

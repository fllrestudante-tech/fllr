// Telemetria do modo DEMO_EXECUTION_MODE=observe -- última análise do
// ciclo e última decisão HIPOTÉTICA ("would_trade"/"would_close"/
// "would_protect") que a estratégia produziria SE a execução estivesse
// ligada. Arquivo PRÓPRIO, completamente separado de
// runtime/demo/order-ledger.json e runtime/demo/last-decision.json
// (lib/demoOrderLedger.js) -- uma decisão hipotética NUNCA é gravada
// como reserva/ordem real, nunca conta pra frequência/cooldown do gate,
// nunca aparece misturada com o histórico de decisões REAIS do gate
// canônico (lib/demoOrderGate.js). Ler runtime/demo/observe-state.json
// (ou o override de teste via CRYPTO10_DEMO_RUNTIME_DIR) é o ÚNICO jeito
// de saber "o que o bot teria feito" -- nunca inferido de outro lugar.
//
// Escrita atômica (lib/atomicWrite.js), mesma disciplina de todo
// runtime/demo/*.json deste projeto. Nunca lança pra quem grava (best-
// effort -- uma falha de disco aqui não pode derrubar o ciclo principal
// do bot); leitura nunca lança pra quem lê (dashboard) -- ausente/
// corrompido vira `null`, nunca um valor inventado.
const fs = require("fs");
const path = require("path");
const { atomicWriteJsonSync } = require("./atomicWrite");
const { demoRuntimeDir } = require("./demoRuntimePaths");

const DEFAULT_OBSERVE_STATE_PATH = path.join(demoRuntimeDir(), "observe-state.json");

const HYPOTHETICAL_KINDS = Object.freeze({
  WOULD_OPEN: "would_open",
  WOULD_CLOSE: "would_close",
  WOULD_PROTECT: "would_protect",
});

function readRaw(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Grava só o campo `lastAnalysis` -- preserva `lastHypotheticalDecision`
 * já gravado antes (leitura+merge, nunca um write que apaga o outro
 * campo). `reasons` sempre um array de strings curtas (mesmo vocabulário
 * de lib/signal.js), nunca texto livre longo.
 */
function recordAnalysis({ filePath = DEFAULT_OBSERVE_STATE_PATH, signal, price, reasons, regime, atMs = Date.now() } = {}) {
  try {
    const current = readRaw(filePath);
    current.lastAnalysis = { signal, price, reasons: Array.isArray(reasons) ? reasons : [], regime, at: new Date(atMs).toISOString() };
    atomicWriteJsonSync(filePath, current);
  } catch {
    // best-effort -- telemetria de observação nunca derruba o ciclo principal
  }
}

/**
 * Grava só o campo `lastHypotheticalDecision` -- mesma disciplina de
 * leitura+merge de recordAnalysis. `wouldTrade`/`kind` sempre presentes;
 * `qty`/`stopLossPrice` como STRING decimal quando aplicável (nunca
 * Number -- mesma disciplina financeira de lib/decimalSafety.js, mesmo
 * este valor nunca indo pra Bybit); `blockReason` null quando não há
 * bloqueio (decisão executaria se a execução estivesse ligada).
 */
function recordHypotheticalDecision({ filePath = DEFAULT_OBSERVE_STATE_PATH, kind, wouldTrade, side = null, qty = null, stopLossPrice = null, blockReason = null, atMs = Date.now() } = {}) {
  try {
    const current = readRaw(filePath);
    current.lastHypotheticalDecision = { kind, wouldTrade, side, qty, stopLossPrice, blockReason, at: new Date(atMs).toISOString() };
    atomicWriteJsonSync(filePath, current);
  } catch {
    // best-effort -- mesma disciplina de recordAnalysis
  }
}

/** Nunca lança -- ausente/corrompido vira { lastAnalysis: null, lastHypotheticalDecision: null }, nunca um valor inventado. */
function readObserveState(filePath = DEFAULT_OBSERVE_STATE_PATH) {
  const raw = readRaw(filePath);
  return {
    lastAnalysis: raw.lastAnalysis && typeof raw.lastAnalysis === "object" ? raw.lastAnalysis : null,
    lastHypotheticalDecision: raw.lastHypotheticalDecision && typeof raw.lastHypotheticalDecision === "object" ? raw.lastHypotheticalDecision : null,
  };
}

module.exports = {
  DEFAULT_OBSERVE_STATE_PATH,
  HYPOTHETICAL_KINDS,
  recordAnalysis,
  recordHypotheticalDecision,
  readObserveState,
};

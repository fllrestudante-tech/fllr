const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  CorruptOrderLedgerError,
  CorruptPrivateCallOutcomesError,
  readLedger,
  getRecentOrderTimestamps,
  getLastOrderAt,
  isOrderLinkIdUsed,
  recordOrderAttempt,
  recordPrivateCallOutcome,
  getConsecutiveErrorCount,
  getConsecutiveErrorCountForAuthorization,
  getLastSuccessfulReadAt,
  recordLastDecision,
  getLastDecision,
} = require("../lib/demoOrderLedger");

function tempPaths(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bot-cripto10-orderledger-${label}-`));
  return {
    dir,
    ledgerPath: path.join(dir, "order-ledger.json"),
    outcomesPath: path.join(dir, "outcomes.json"),
    decisionPath: path.join(dir, "last-decision.json"),
  };
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const NOW = 1_756_000_000_000;

// =====================================================================
// Ledger de ordens -- frequência/cooldown/idempotência
// =====================================================================

test("readLedger: arquivo ausente -> ledger vazio", (t) => {
  const { dir, ledgerPath } = tempPaths("absent");
  t.after(() => cleanup(dir));
  assert.deepEqual(readLedger(ledgerPath), { orders: [] });
});

test("readLedger: arquivo corrompido -> lança CorruptOrderLedgerError (fail-closed, nunca finge vazio)", (t) => {
  const { dir, ledgerPath } = tempPaths("corrupt");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, "não é json");
  assert.throws(() => readLedger(ledgerPath), CorruptOrderLedgerError);
});

test("recordOrderAttempt + getRecentOrderTimestamps: só retorna timestamps dentro da janela pedida", (t) => {
  const { dir, ledgerPath } = tempPaths("recent");
  t.after(() => cleanup(dir));
  recordOrderAttempt(ledgerPath, { orderLinkId: "a", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 30000 });
  recordOrderAttempt(ledgerPath, { orderLinkId: "b", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 5000 });
  recordOrderAttempt(ledgerPath, { orderLinkId: "c", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 999999 }); // fora da janela
  const timestamps = getRecentOrderTimestamps(ledgerPath, { windowMs: 60000, now: NOW });
  assert.deepEqual(timestamps.sort(), [NOW - 30000, NOW - 5000]);
});

test("getLastOrderAt: ausente -> null; presente -> o mais recente", (t) => {
  const { dir, ledgerPath } = tempPaths("last-order");
  t.after(() => cleanup(dir));
  assert.equal(getLastOrderAt(ledgerPath), null);
  recordOrderAttempt(ledgerPath, { orderLinkId: "a", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 5000 });
  recordOrderAttempt(ledgerPath, { orderLinkId: "b", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 1000 });
  assert.equal(getLastOrderAt(ledgerPath), NOW - 1000);
});

test("isOrderLinkIdUsed: detecta reuso corretamente", (t) => {
  const { dir, ledgerPath } = tempPaths("reuse");
  t.after(() => cleanup(dir));
  assert.equal(isOrderLinkIdUsed(ledgerPath, "x"), false);
  recordOrderAttempt(ledgerPath, { orderLinkId: "x", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW });
  assert.equal(isOrderLinkIdUsed(ledgerPath, "x"), true);
  assert.equal(isOrderLinkIdUsed(ledgerPath, "y"), false);
});

test("recordOrderAttempt: poda entradas mais velhas que 24h a cada escrita", (t) => {
  const { dir, ledgerPath } = tempPaths("prune");
  t.after(() => cleanup(dir));
  recordOrderAttempt(ledgerPath, { orderLinkId: "old", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW - 25 * 60 * 60 * 1000 });
  recordOrderAttempt(ledgerPath, { orderLinkId: "new", symbol: "SOLUSDT", kind: "INCREASE_EXPOSURE", atMs: NOW });
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.orders.length, 1);
  assert.equal(ledger.orders[0].orderLinkId, "new");
});

// =====================================================================
// Outcomes -- erros consecutivos / último read bem-sucedido
// =====================================================================

test("getConsecutiveErrorCount: arquivo ausente -> 0", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-absent");
  t.after(() => cleanup(dir));
  assert.equal(getConsecutiveErrorCount(outcomesPath), 0);
});

test("getConsecutiveErrorCount: conta falhas a partir do mais recente, parando no primeiro sucesso", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-count");
  t.after(() => cleanup(dir));
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 5000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 4000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 3000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 2000 });
  assert.equal(getConsecutiveErrorCount(outcomesPath), 3);
});

test("getConsecutiveErrorCount: sucesso mais recente zera a contagem mesmo com falhas antes dele", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-reset");
  t.after(() => cleanup(dir));
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 3000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 2000 });
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 1000 });
  assert.equal(getConsecutiveErrorCount(outcomesPath), 0);
});

test("getConsecutiveErrorCount: arquivo corrompido -> 0 (versão TELEMETRIA -- painel, nunca usada pra autorizar aumento de exposição)", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-corrupt");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
  fs.writeFileSync(outcomesPath, "não é json");
  assert.equal(getConsecutiveErrorCount(outcomesPath), 0);
});

// =====================================================================
// getConsecutiveErrorCountForAuthorization -- versão FAIL-CLOSED
// (Bloqueador 6), usada SÓ por lib/demoOrderGate.js pra autorizar
// aumento de exposição. Ausente = 0 (estado inicial legítimo); presente
// mas corrompido = LANÇA (nunca finge 0 -- isso poderia mascarar uma
// sequência real de falhas e liberar uma ordem que deveria travar).
// =====================================================================

test("getConsecutiveErrorCountForAuthorization: arquivo ausente -> 0 (estado inicial legítimo, não é corrupção)", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-auth-absent");
  t.after(() => cleanup(dir));
  assert.equal(getConsecutiveErrorCountForAuthorization(outcomesPath), 0);
});

test("getConsecutiveErrorCountForAuthorization: conta falhas a partir do mais recente, parando no primeiro sucesso (mesmo comportamento da telemetria quando o arquivo é válido)", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-auth-count");
  t.after(() => cleanup(dir));
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 5000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 4000 });
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 3000 });
  assert.equal(getConsecutiveErrorCountForAuthorization(outcomesPath), 2);
});

test("getConsecutiveErrorCountForAuthorization: arquivo PRESENTE mas corrompido -> LANÇA CorruptPrivateCallOutcomesError, nunca finge 0 (fail-closed)", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-auth-corrupt");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
  fs.writeFileSync(outcomesPath, "não é json");
  assert.throws(() => getConsecutiveErrorCountForAuthorization(outcomesPath), CorruptPrivateCallOutcomesError);
});

test("getConsecutiveErrorCountForAuthorization: formato inesperado (outcomes não é array) -> lança, nunca finge 0", (t) => {
  const { dir, outcomesPath } = tempPaths("errors-auth-shape");
  t.after(() => cleanup(dir));
  fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
  fs.writeFileSync(outcomesPath, JSON.stringify({ outcomes: "não é um array" }));
  assert.throws(() => getConsecutiveErrorCountForAuthorization(outcomesPath), CorruptPrivateCallOutcomesError);
});

test("getLastSuccessfulReadAt: ausente -> null", (t) => {
  const { dir, outcomesPath } = tempPaths("read-absent");
  t.after(() => cleanup(dir));
  assert.equal(getLastSuccessfulReadAt(outcomesPath), null);
});

test("getLastSuccessfulReadAt: só considera READS bem-sucedidos, ignora mutações e falhas", (t) => {
  const { dir, outcomesPath } = tempPaths("read-only");
  t.after(() => cleanup(dir));
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 5000, context: "placeOrder" }); // mutação -- ignorado
  recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW - 4000, context: "getWalletBalance" }); // read falho -- ignorado
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 3000, context: "getWalletBalance" }); // read ok -- conta
  recordPrivateCallOutcome(outcomesPath, { success: true, atMs: NOW - 2000, context: "setLeverage" }); // mutação -- ignorado
  assert.equal(getLastSuccessfulReadAt(outcomesPath), NOW - 3000);
});

test("recordPrivateCallOutcome: mantém só a cauda recente (MAX_OUTCOMES_TRACKED)", (t) => {
  const { dir, outcomesPath } = tempPaths("outcomes-cap");
  t.after(() => cleanup(dir));
  for (let i = 0; i < 60; i++) {
    recordPrivateCallOutcome(outcomesPath, { success: false, atMs: NOW + i, context: "getWalletBalance" });
  }
  const raw = JSON.parse(fs.readFileSync(outcomesPath, "utf8"));
  assert.ok(raw.outcomes.length <= 50);
});

// =====================================================================
// Última decisão do gate (Bloqueador 7 -- lastDecision/blockReason)
// =====================================================================

test("getLastDecision: ausente -> null", (t) => {
  const { dir, decisionPath } = tempPaths("decision-absent");
  t.after(() => cleanup(dir));
  assert.equal(getLastDecision(decisionPath), null);
});

test("recordLastDecision + getLastDecision: grava e lê de volta corretamente", (t) => {
  const { dir, decisionPath } = tempPaths("decision-roundtrip");
  t.after(() => cleanup(dir));
  recordLastDecision(decisionPath, { allowed: false, kind: "INCREASE_EXPOSURE", opName: "placeOrder", reason: "notional_exceeds_limit", atMs: NOW });
  const decision = getLastDecision(decisionPath);
  assert.equal(decision.allowed, false);
  assert.equal(decision.kind, "INCREASE_EXPOSURE");
  assert.equal(decision.reason, "notional_exceeds_limit");
  assert.equal(decision.atMs, NOW);
});

test("recordLastDecision: nunca lança mesmo com caminho inválido (telemetria nunca derruba uma decisão real)", () => {
  assert.doesNotThrow(() => recordLastDecision("Z:\\caminho\\que\\nao\\existe\\de\\jeito\\nenhum\\arquivo.json", { allowed: true, kind: "READ", opName: "x" }));
});

// CRYPTO10_TEST_WORKER + CRYPTO10_DEMO_RUNTIME_DIR (dentro de
// os.tmpdir()) ANTES de requerer lib/demoObserveState -- mesma
// disciplina de todo teste que grava em runtime/demo/*, nunca toca o
// runtime/demo/ operacional real.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const TEST_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-observestate-"));
process.env.CRYPTO10_TEST_WORKER = "1";
process.env.CRYPTO10_DEMO_RUNTIME_DIR = TEST_RUNTIME_DIR;
test.after(() => fs.rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true }));

const assert = require("node:assert/strict");
const { HYPOTHETICAL_KINDS, recordAnalysis, recordHypotheticalDecision, readObserveState } = require("../lib/demoObserveState");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-observestate-file-")), "observe-state.json");
}

test("readObserveState: arquivo ausente -> { lastAnalysis: null, lastHypotheticalDecision: null }, nunca lança", () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-observestate-missing-")), "nao-existe.json");
  assert.deepEqual(readObserveState(filePath), { lastAnalysis: null, lastHypotheticalDecision: null });
});

test("readObserveState: arquivo corrompido (JSON inválido) -> ambos null, nunca lança", () => {
  const filePath = tmpPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ isto nao e json valido");
  assert.deepEqual(readObserveState(filePath), { lastAnalysis: null, lastHypotheticalDecision: null });
});

test("recordAnalysis + readObserveState: grava e lê de volta lastAnalysis, reasons sempre array", () => {
  const filePath = tmpPath();
  recordAnalysis({ filePath, signal: "wait", price: 42.5, reasons: ["ema_flat"], regime: "normal", atMs: 1_756_000_000_000 });
  const result = readObserveState(filePath);
  assert.equal(result.lastAnalysis.signal, "wait");
  assert.equal(result.lastAnalysis.price, 42.5);
  assert.deepEqual(result.lastAnalysis.reasons, ["ema_flat"]);
  assert.equal(result.lastAnalysis.regime, "normal");
  assert.equal(result.lastAnalysis.at, new Date(1_756_000_000_000).toISOString());
  assert.equal(result.lastHypotheticalDecision, null);
});

test("recordAnalysis: reasons ausente/não-array -> normalizado pra array vazio, nunca lança", () => {
  const filePath = tmpPath();
  recordAnalysis({ filePath, signal: "buy", price: 10, reasons: undefined, regime: "high" });
  assert.deepEqual(readObserveState(filePath).lastAnalysis.reasons, []);
});

test("recordHypotheticalDecision + readObserveState: grava e lê de volta lastHypotheticalDecision, preserva lastAnalysis já gravado (merge, nunca sobrescreve o outro campo)", () => {
  const filePath = tmpPath();
  recordAnalysis({ filePath, signal: "buy", price: 40, reasons: ["cruzamento_ema"], regime: "normal", atMs: 1_756_000_000_000 });
  recordHypotheticalDecision({
    filePath,
    kind: HYPOTHETICAL_KINDS.WOULD_OPEN,
    wouldTrade: true,
    side: "Buy",
    qty: "1.5",
    stopLossPrice: "38",
    blockReason: null,
    atMs: 1_756_000_001_000,
  });
  const result = readObserveState(filePath);
  assert.equal(result.lastAnalysis.signal, "buy"); // preservado, não sobrescrito pelo record seguinte
  assert.equal(result.lastHypotheticalDecision.kind, HYPOTHETICAL_KINDS.WOULD_OPEN);
  assert.equal(result.lastHypotheticalDecision.wouldTrade, true);
  assert.equal(result.lastHypotheticalDecision.side, "Buy");
  assert.equal(result.lastHypotheticalDecision.qty, "1.5"); // string decimal, nunca Number
  assert.equal(result.lastHypotheticalDecision.stopLossPrice, "38");
  assert.equal(result.lastHypotheticalDecision.blockReason, null);
});

test("recordHypotheticalDecision: wouldTrade=false com blockReason -- vocabulário estável, nunca inventa sucesso", () => {
  const filePath = tmpPath();
  recordHypotheticalDecision({ filePath, kind: HYPOTHETICAL_KINDS.WOULD_OPEN, wouldTrade: false, side: "Sell", qty: null, stopLossPrice: null, blockReason: "qty_zero" });
  const result = readObserveState(filePath);
  assert.equal(result.lastHypotheticalDecision.wouldTrade, false);
  assert.equal(result.lastHypotheticalDecision.qty, null);
  assert.equal(result.lastHypotheticalDecision.blockReason, "qty_zero");
});

test("recordAnalysis/recordHypotheticalDecision: escrita best-effort -- diretório pai inexistente é criado (atomicWriteJsonSync), nunca lança pro chamador", () => {
  const nestedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-observestate-nested-")), "a", "b", "observe-state.json");
  assert.doesNotThrow(() => recordAnalysis({ filePath: nestedPath, signal: "wait", price: 1, reasons: [], regime: "normal" }));
  assert.equal(readObserveState(nestedPath).lastAnalysis.signal, "wait");
});

test("nenhum teste deste arquivo importa net/http/axios diretamente -- só grava/lê arquivo local", () => {
  const firstTestLine = fs
    .readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((line) => line.startsWith("test("));
  const importsOnly = fs.readFileSync(__filename, "utf8").split("\n").slice(0, firstTestLine).join("\n");
  for (const token of ["node:http", '"http"', "node:net", '"net"', "axios"]) {
    assert.ok(!importsOnly.includes(token), `imports deste arquivo não deveriam mencionar "${token}"`);
  }
});

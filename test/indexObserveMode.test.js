// Prova, via require("../index.js") EM PROCESSO (nunca subprocesso --
// diferente de test/indexBootGate.test.js, que só prova o BLOQUEIO de
// boot em processos separados), que DEMO_EXECUTION_MODE=observe nunca
// deixa nenhuma função mutável alcançar HMAC/Axios. Env demo válido +
// DEMO_EXECUTION_MODE=observe são setados ANTES de qualquer require --
// index.js só expõe { boot, cycle, openPosition, ... } (nunca chama
// boot() sozinho) porque `require.main !== module` quando requerido a
// partir de um teste (ver `if (require.main === module) boot();` no
// fim do arquivo).
//
// CRYPTO10_TEST_WORKER + CRYPTO10_DEMO_RUNTIME_DIR (dentro de
// os.tmpdir()) ANTES do require -- runtime/demo/observe-state.json
// (lib/demoObserveState.js) e o resto do runtime demo usam o caminho
// resolvido no require() dos módulos, nunca em tempo de chamada.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const TEST_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-observemode-"));
process.env.CRYPTO10_TEST_WORKER = "1";
process.env.CRYPTO10_DEMO_RUNTIME_DIR = TEST_RUNTIME_DIR;
process.env.SUPERVISOR_PROFILE = "demo";
process.env.BYBIT_DEMO = "true";
process.env.BYBIT_TESTNET = "false";
process.env.BYBIT_API_KEY = "fake-key-not-a-real-secret";
process.env.BYBIT_API_SECRET = "fake-secret-not-real";
process.env.DEMO_EXECUTION_MODE = "observe";
test.after(() => fs.rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true }));

const assert = require("node:assert/strict");
const axios = require("axios");
const bybit = require("../lib/bybit");
const logger = require("../lib/logger");
const ledger = require("../lib/demoOrderLedger");
const stateModule = require("../lib/state");
const { readObserveState } = require("../lib/demoObserveState");
const idx = require("../index.js");

const { DEFAULT_STATE } = stateModule;

const INSTRUMENT_INFO = {
  symbol: "SOLUSDT",
  qtyStep: "0.1",
  minOrderQty: "0.1",
  maxOrderQty: "96000.0",
  maxMktOrderQty: "12000.0",
  tickSize: "0.01",
  minPrice: "0.01",
  maxPrice: "199999.98",
  minNotionalValue: "5",
};

function mockAxiosNeverCalled(t) {
  let getCalls = 0;
  let postCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    throw new Error("axios.get não deveria ser chamado -- todas as leituras deveriam estar mockadas no nível de lib/bybit.js");
  });
  t.mock.method(axios, "post", async () => {
    postCalls++;
    throw new Error("axios.post nunca deveria ser chamado em DEMO_EXECUTION_MODE=observe");
  });
  return { getCalls: () => getCalls, postCalls: () => postCalls };
}

function mockGoodReads(t, { leverage = "2", size = "0" } = {}) {
  t.mock.method(bybit, "getWalletBalance", async () => ({ totalEquity: "1000" }));
  t.mock.method(bybit, "getPositions", async () => [{ symbol: "SOLUSDT", side: "", size, leverage, tradeMode: 0, positionIdx: 0 }]);
  t.mock.method(bybit, "getOpenOrders", async () => []);
  t.mock.method(bybit, "getInstrumentInfo", async () => INSTRUMENT_INFO);
}

function mockTelemetry(t) {
  t.mock.method(logger, "log", () => {});
  t.mock.method(logger, "logAlert", () => {});
  t.mock.method(stateModule, "save", () => {});
}

function mockLedgerNeverReserves(t) {
  let recordOrderAttemptCalls = 0;
  t.mock.method(ledger, "recordOrderAttempt", () => {
    recordOrderAttemptCalls++;
  });
  return { recordOrderAttemptCalls: () => recordOrderAttemptCalls };
}

test("index.js require()ado em processo de teste: EXECUTION_MODE exportado é exatamente 'observe'", () => {
  assert.equal(idx.EXECUTION_MODE, idx.EXECUTION_MODES.OBSERVE);
});

test("índice: TRADING_EXECUTION_ENABLED continua false/ausente no ambiente deste teste (precondição do modo observe)", () => {
  assert.notEqual(process.env.TRADING_EXECUTION_ENABLED, "true");
});

// =====================================================================
// openPosition -- item 1: "quando a estratégia quiser operar, registre
// would_trade... nunca chame placeOrder/setTradingStop".
// =====================================================================

test("openPosition (observe): qty>0 -> registra would_trade wouldTrade=true, ZERO chamadas a axios/placeOrder/ledger", async (t) => {
  mockGoodReads(t);
  mockTelemetry(t);
  const axiosSpy = mockAxiosNeverCalled(t);
  const ledgerSpy = mockLedgerNeverReserves(t);
  idx.setBotState({ ...DEFAULT_STATE });
  idx.setInstrumentInfo(INSTRUMENT_INFO);

  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 1000);

  assert.equal(axiosSpy.getCalls(), 0);
  assert.equal(axiosSpy.postCalls(), 0);
  assert.equal(ledgerSpy.recordOrderAttemptCalls(), 0, "decisão hipotética nunca deveria gravar reserva no ledger real");

  const observe = readObserveState();
  assert.equal(observe.lastHypotheticalDecision.kind, "would_open");
  assert.equal(observe.lastHypotheticalDecision.wouldTrade, true);
  assert.equal(observe.lastHypotheticalDecision.side, "Buy");
  assert.equal(typeof observe.lastHypotheticalDecision.qty, "string"); // qty normalizada como string decimal, nunca Number
  assert.equal(observe.lastHypotheticalDecision.blockReason, null);

  // botState nunca foi mutado como se a ordem tivesse sido enviada de verdade
  assert.equal(idx.getBotState().isOpened, false);
});

test("openPosition (observe): risk.planOrder resulta em qty zero -> wouldTrade=false, blockReason='qty_zero'", async (t) => {
  mockGoodReads(t);
  mockTelemetry(t);
  mockAxiosNeverCalled(t);
  idx.setBotState({ ...DEFAULT_STATE });
  idx.setInstrumentInfo(INSTRUMENT_INFO);

  // equity=0 -> riskAmount=0 -> qty=0 em risk.planOrder
  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 0);

  const observe = readObserveState();
  assert.equal(observe.lastHypotheticalDecision.wouldTrade, false);
  assert.equal(observe.lastHypotheticalDecision.blockReason, "qty_zero");
  assert.equal(observe.lastHypotheticalDecision.qty, null);
});

test("openPosition (observe): snapshot indisponível (leitura falha) -> aborta ANTES até de avaliar would_trade, nenhuma chamada axios", async (t) => {
  mockTelemetry(t);
  const axiosSpy = mockAxiosNeverCalled(t);
  t.mock.method(bybit, "getWalletBalance", async () => {
    throw new Error("falha simulada de leitura privada");
  });
  t.mock.method(bybit, "getPositions", async () => []);
  t.mock.method(bybit, "getOpenOrders", async () => []);
  t.mock.method(bybit, "getInstrumentInfo", async () => INSTRUMENT_INFO);
  idx.setBotState({ ...DEFAULT_STATE });
  idx.setInstrumentInfo(INSTRUMENT_INFO);

  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 1000);

  assert.equal(axiosSpy.getCalls(), 0);
  assert.equal(axiosSpy.postCalls(), 0);
});

// =====================================================================
// closePosition / applyBreakEven / applyTrailingStop -- nenhuma função
// mutável chamada, decisão hipotética registrada (would_close/would_protect).
// =====================================================================

test("closePosition (observe): registra would_close, ZERO axios.post, botState local não é limpo como se tivesse fechado de verdade", async (t) => {
  mockTelemetry(t);
  const axiosSpy = mockAxiosNeverCalled(t);
  const openState = { ...DEFAULT_STATE, isOpened: true, side: "Buy", qty: 2, entryPrice: 40 };
  idx.setBotState(openState);

  await idx.closePosition("signal_reversal", 1000);

  assert.equal(axiosSpy.postCalls(), 0);
  const observe = readObserveState();
  assert.equal(observe.lastHypotheticalDecision.kind, "would_close");
  assert.equal(observe.lastHypotheticalDecision.wouldTrade, true);
  assert.equal(observe.lastHypotheticalDecision.blockReason, "execution_mode_observe");
  assert.equal(idx.getBotState().isOpened, true, "posição local continua marcada como aberta -- nenhuma ordem de fechamento foi realmente enviada");
});

test("applyBreakEven (observe): registra would_protect, ZERO axios.post, breakEvenApplied não é marcado como aplicado de verdade", async (t) => {
  mockTelemetry(t);
  const axiosSpy = mockAxiosNeverCalled(t);
  idx.setBotState({ ...DEFAULT_STATE, isOpened: true, side: "Buy", qty: 2, entryPrice: 40, breakEvenApplied: false });

  await idx.applyBreakEven({ price: 41 });

  assert.equal(axiosSpy.postCalls(), 0);
  const observe = readObserveState();
  assert.equal(observe.lastHypotheticalDecision.kind, "would_protect");
  assert.equal(idx.getBotState().breakEvenApplied, false);
});

test("applyTrailingStop (observe): registra would_protect, ZERO axios.post, trailingActivated não é marcado como aplicado de verdade", async (t) => {
  mockTelemetry(t);
  const axiosSpy = mockAxiosNeverCalled(t);
  idx.setBotState({ ...DEFAULT_STATE, isOpened: true, side: "Buy", qty: 2, entryPrice: 40, trailingActivated: false });

  await idx.applyTrailingStop(0.5, "normal");

  assert.equal(axiosSpy.postCalls(), 0);
  const observe = readObserveState();
  assert.equal(observe.lastHypotheticalDecision.kind, "would_protect");
  assert.equal(idx.getBotState().trailingActivated, false);
});

// =====================================================================
// maybeConfigureLeverageOnBoot -- boot nunca chama setLeverage em observe.
// =====================================================================

test("maybeConfigureLeverageOnBoot (observe): NUNCA chama bybit.setLeverage", async (t) => {
  let setLeverageCalls = 0;
  t.mock.method(bybit, "setLeverage", async () => {
    setLeverageCalls++;
  });
  await idx.maybeConfigureLeverageOnBoot();
  assert.equal(setLeverageCalls, 0);
});

test("nenhum teste deste arquivo espera que index.js chame boot()/loop() sozinho ao ser requerido (require.main check)", () => {
  // Se boot() tivesse disparado sozinho no require(), o timer de
  // backtest/health check já teria sido agendado e este processo de
  // teste nunca terminaria sozinho -- o próprio node --test concluindo
  // este arquivo (sem --test-force-exit) já é a prova em tempo de
  // execução; esta asserção só documenta a expectativa explicitamente.
  assert.equal(typeof idx.boot, "function");
});

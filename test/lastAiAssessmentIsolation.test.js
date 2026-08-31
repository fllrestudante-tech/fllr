// Prova ATIVA (mesmo padrão de mockAxiosNeverCalled em
// test/indexObserveMode.test.js) de que NENHUM consumidor financeiro/de
// execução (openPosition, closePosition -- os únicos pontos em index.js que
// decidem mandar ordem à Bybit) lê botState.lastAiAssessment. O AI Gateway é
// shadow-only por design (ver comentário de index.js::maybeRunAiAssessment e
// lib/state.js::DEFAULT_STATE) -- este teste prova isso ativamente em vez de
// só documentar a intenção:
//
//   1) prova ESTRUTURAL -- varre index.js e lib/risk.js (os únicos lugares
//      onde uma decisão de abrir/fechar posição é calculada) e confirma que
//      o token `lastAiAssessment` só aparece nos DOIS pontos já conhecidos e
//      documentados em index.js (a escrita em maybeRunAiAssessment e a
//      leitura só-de-log no status de dashboard) -- nunca dentro do corpo de
//      openPosition/closePosition. lib/risk.js nunca deveria conter o token
//      nenhuma vez.
//   2) prova DINÂMICA -- roda openPosition/closePosition de verdade (modo
//      observe, mesmos mocks de test/indexObserveMode.test.js) com um
//      botState envolvido num Proxy que registra QUALQUER leitura da
//      propriedade lastAiAssessment, e afirma zero leituras.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const TEST_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-aiassess-isolation-"));
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
const stateModule = require("../lib/state");
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
  t.mock.method(axios, "get", async () => {
    throw new Error("axios.get não deveria ser chamado neste teste");
  });
  t.mock.method(axios, "post", async () => {
    throw new Error("axios.post não deveria ser chamado neste teste");
  });
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

// Um valor de lastAiAssessment deliberadamente "envenenado" -- se qualquer
// caminho de decisão financeira o lesse e se comportasse de acordo, teria
// que produzir wouldTrade=false apesar de qty>0 (ou algum outro desvio do
// comportamento esperado só-de-risk.planOrder). O teste não precisa nem
// avaliar esse efeito -- a prova é que a leitura em si nunca acontece.
const POISONED_ASSESSMENT = {
  at: "2026-08-30T10:00:00.000Z",
  recommendation: "close_all_immediately",
  marketRegime: "crash",
  riskLevel: "critical",
};

function wrapStateWithReadTracker(base) {
  const reads = [];
  const proxy = new Proxy(
    { ...base },
    {
      get(target, prop, receiver) {
        if (prop === "lastAiAssessment") reads.push(new Error("leitura de lastAiAssessment capturada").stack);
        return Reflect.get(target, prop, receiver);
      },
    }
  );
  return { proxy, reads };
}

test("prova estrutural: token 'lastAiAssessment' em index.js só aparece nos 2 pontos já conhecidos (escrita em maybeRunAiAssessment + leitura só-de-log no status), nunca dentro de openPosition/closePosition", () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const matches = [...indexSrc.matchAll(/lastAiAssessment/g)];
  assert.equal(matches.length, 2, `esperava exatamente 2 ocorrências de lastAiAssessment em index.js, encontrou ${matches.length}`);

  const openPositionSrc = indexSrc.slice(indexSrc.indexOf("async function openPosition("), indexSrc.indexOf("\nasync function closePosition("));
  const closePositionSrc = indexSrc.slice(indexSrc.indexOf("async function closePosition("), indexSrc.indexOf("\nasync function ", indexSrc.indexOf("async function closePosition(") + 1));

  assert.ok(!openPositionSrc.includes("lastAiAssessment"), "openPosition não deveria referenciar lastAiAssessment");
  assert.ok(!closePositionSrc.includes("lastAiAssessment"), "closePosition não deveria referenciar lastAiAssessment");
});

test("prova estrutural: lib/risk.js (planOrder/canExecute/registerTradeResult) nunca referencia lastAiAssessment", () => {
  const riskSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "risk.js"), "utf8");
  assert.ok(!riskSrc.includes("lastAiAssessment"), "lib/risk.js não deveria referenciar lastAiAssessment em nenhum ponto");
});

test("prova dinâmica: openPosition (observe) com lastAiAssessment envenenado -> ZERO leituras da propriedade durante a chamada", async (t) => {
  mockGoodReads(t);
  mockTelemetry(t);
  mockAxiosNeverCalled(t);
  const { proxy, reads } = wrapStateWithReadTracker({ ...DEFAULT_STATE, lastAiAssessment: POISONED_ASSESSMENT });
  idx.setBotState(proxy);
  idx.setInstrumentInfo(INSTRUMENT_INFO);

  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 1000);

  assert.equal(reads.length, 0, `lastAiAssessment foi lido ${reads.length} vez(es) durante openPosition -- primeira captura:\n${reads[0]}`);
});

test("prova dinâmica: closePosition (observe) com lastAiAssessment envenenado -> ZERO leituras da propriedade durante a chamada", async (t) => {
  mockTelemetry(t);
  mockAxiosNeverCalled(t);
  const { proxy, reads } = wrapStateWithReadTracker({ ...DEFAULT_STATE, isOpened: true, side: "Buy", qty: 2, entryPrice: 40, lastAiAssessment: POISONED_ASSESSMENT });
  idx.setBotState(proxy);

  await idx.closePosition("signal_reversal", 1000);

  assert.equal(reads.length, 0, `lastAiAssessment foi lido ${reads.length} vez(es) durante closePosition -- primeira captura:\n${reads[0]}`);
});

test("prova dinâmica: openPosition (observe) produz o MESMO wouldTrade/qty com lastAiAssessment envenenado vs. ausente -- comportamento nunca varia com o conteúdo do assessment", async (t) => {
  mockGoodReads(t);
  mockTelemetry(t);
  mockAxiosNeverCalled(t);
  const { readObserveState } = require("../lib/demoObserveState");

  idx.setBotState({ ...DEFAULT_STATE, lastAiAssessment: null });
  idx.setInstrumentInfo(INSTRUMENT_INFO);
  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 1000);
  const withoutAssessment = readObserveState().lastHypotheticalDecision;

  idx.setBotState({ ...DEFAULT_STATE, lastAiAssessment: POISONED_ASSESSMENT });
  idx.setInstrumentInfo(INSTRUMENT_INFO);
  await idx.openPosition("buy", { price: 40, atr: 1, params: { stopLossPct: 0.01 } }, 1000);
  const withAssessment = readObserveState().lastHypotheticalDecision;

  assert.equal(withAssessment.wouldTrade, withoutAssessment.wouldTrade);
  assert.equal(withAssessment.qty, withoutAssessment.qty);
  assert.equal(withAssessment.side, withoutAssessment.side);
  assert.equal(withAssessment.blockReason, withoutAssessment.blockReason);
});

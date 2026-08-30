// Item 3 da Rodada 4 -- ciclo integrado: refresh snapshot -> decisão ->
// gate -> privatePost mockado; e falha no refresh -> nenhuma chamada
// mutável. Axios sempre mockado (t.mock.method) -- nenhum teste deste
// arquivo toca rede real.
//
// CRYPTO10_TEST_WORKER + CRYPTO10_DEMO_RUNTIME_DIR (dentro de
// os.tmpdir(), exigidos por lib/demoRuntimePaths.js -- item 4 da Rodada
// 4) são setados ANTES de qualquer require de lib/*, pra que
// DEFAULT_SNAPSHOT_PATH/DEFAULT_LAST_DECISION_PATH/etc já nasçam
// isolados neste processo de teste, nunca apontando pro runtime/demo/
// operacional real.
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const TEST_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-snapshotrefresh-"));
process.env.CRYPTO10_TEST_WORKER = "1";
process.env.CRYPTO10_DEMO_RUNTIME_DIR = TEST_RUNTIME_DIR;
test.after(() => fs.rmSync(TEST_RUNTIME_DIR, { recursive: true, force: true }));

const assert = require("node:assert/strict");
const axios = require("axios");
const bybit = require("../lib/bybit");
const { refreshDemoAccountSnapshot, DemoSnapshotRefreshFailedError, reduceLeverageSafely, LeverageReductionNotConfirmedError } = require("../lib/demoSnapshotRefresh");
const { mockDemoAuth } = require("./helpers/demoAuthMocks");
const snapshotModule = require("../lib/demoAccountSnapshot");
const killSwitch = require("../lib/killSwitch");

function validDemoEnv(overrides = {}) {
  return {
    SUPERVISOR_PROFILE: "demo",
    BYBIT_DEMO: "true",
    BYBIT_TESTNET: "false",
    BYBIT_API_KEY: "fake-key-not-a-real-secret",
    BYBIT_API_SECRET: "fake-secret-not-real",
    ...overrides,
  };
}

function withEnv(t, overrides) {
  const prev = {};
  for (const key of Object.keys(overrides)) prev[key] = process.env[key];
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const key of Object.keys(overrides)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  });
}

function enableTradingExecutionForTest(t) {
  const prev = process.env.TRADING_EXECUTION_ENABLED;
  process.env.TRADING_EXECUTION_ENABLED = "true";
  t.after(() => {
    if (prev === undefined) delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = prev;
  });
}

const GOOD_READS = {
  getWalletBalance: async () => ({ totalEquity: "1000", totalAvailableBalance: "1000", raw: {} }),
  // Linha com size="0" pro símbolo (slot inativo) -- ainda assim carrega
  // leverage/tradeMode/positionIdx efetivos, que o gate exige pra
  // autorizar aumento de exposição (item 4 da Rodada 5). leverage "2"
  // bate com o teto default (DEMO_MAX_LEVERAGE) e com o que a ordem de
  // teste abaixo efetivamente propõe.
  getPositions: async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "2", tradeMode: 0, positionIdx: 0 }],
  getOpenOrders: async () => [],
  getInstrumentInfo: async () => ({ qtyStep: "0.1", minOrderQty: "0.1", maxOrderQty: "96000.0", maxMktOrderQty: "12000.0", tickSize: "0.01", minPrice: "0.01", maxPrice: "199999.98", minNotionalValue: "5" }),
};

test("refresh -> decisão -> gate -> privatePost mockado: ciclo completo autoriza e alcança a rede mockada", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  const { readTrustedSnapshotMock } = mockDemoAuth(t, { armed: true }); // mocka killSwitch/ledger/state -- snapshot é o REAL, produzido pelo refresh abaixo

  t.mock.method(bybit, "getWalletBalance", GOOD_READS.getWalletBalance);
  t.mock.method(bybit, "getPositions", GOOD_READS.getPositions);
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  const snapshot = await refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" });
  assert.equal(snapshot.instrumentInfo.symbol, "SOLUSDT");

  // snapshotModule.readTrustedSnapshot é mockado por mockDemoAuth -- mas
  // aqui queremos o snapshot REAL recém-produzido pelo refresh, então
  // trocamos só o retorno desta mesma mock (nunca chamando t.mock.method
  // de novo no mesmo método dentro do mesmo teste -- isso faz o
  // node:test restaurar só a última camada ao fim do teste e deixar a
  // PRIMEIRA mock, o fakeSnapshot() default com leverage "2", vazando
  // pros testes seguintes deste arquivo -- bug real já pisado nesta
  // rodada, ver comentário de mockDemoAuth em test/helpers/demoAuthMocks.js).
  readTrustedSnapshotMock.mock.mockImplementation(() => snapshot);

  let postCalls = 0;
  let capturedBody;
  t.mock.method(axios, "post", async (url, body) => {
    postCalls++;
    capturedBody = JSON.parse(body);
    return { data: { retCode: 0, result: { orderId: "fake" } } };
  });

  const result = await bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 20, stopLoss: 19, orderLinkId: "demo-refresh-ciclo-1" });
  assert.equal(postCalls, 1);
  assert.equal(capturedBody.symbol, "SOLUSDT");
  assert.equal(result.orderId, "fake");
});

test("falha em qualquer leitura do refresh -> refreshDemoAccountSnapshot lança DemoSnapshotRefreshFailedError, nenhum snapshot é gravado", async (t) => {
  withEnv(t, validDemoEnv());
  t.mock.method(bybit, "getWalletBalance", GOOD_READS.getWalletBalance);
  t.mock.method(bybit, "getPositions", async () => {
    throw new Error("timeout simulando falha de leitura privada");
  });
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  await assert.rejects(() => refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" }), DemoSnapshotRefreshFailedError);
});

test("falha no refresh -> nenhuma chamada mutável alcança privatePost/axios.post, mesmo se o chamador tentar placeOrder mesmo assim", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);

  // Kill switch armado de verdade (não mockado) -- prova que mesmo com
  // ARMED_DEMO válido, a AUSÊNCIA de snapshot fresco (porque o refresh
  // abaixo falhou e nunca gravou nada) já bloqueia sozinha.
  const tmpKillSwitchState = { armed: false };
  t.mock.method(killSwitch, "assertNewExposureArmed", () => {
    if (!tmpKillSwitchState.armed) throw new killSwitch.NewExposureBlockedError(killSwitch.STATES.BLOCK_NEW_EXPOSURE, null);
  });

  t.mock.method(bybit, "getWalletBalance", async () => {
    throw new Error("falha simulada de leitura privada (wallet)");
  });
  t.mock.method(bybit, "getPositions", GOOD_READS.getPositions);
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  await assert.rejects(() => refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" }), DemoSnapshotRefreshFailedError);

  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  // Simula o chamador (index.js) ignorando a falha do refresh e tentando
  // mesmo assim -- o próprio gate ainda bloqueia, nunca depende só da
  // disciplina do chamador.
  await assert.rejects(() => bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 20, stopLoss: 19, orderLinkId: "demo-refresh-falha-1" }));
  assert.equal(postCalls, 0, "nenhuma chamada mutável deveria ter alcançado axios.post após falha no refresh");
});

// =====================================================================
// reduceLeverageSafely -- item 4 da Rodada 6. gate (SAFE_LEVERAGE_REDUCTION)
// -> bybit.setLeverage mockado -> refresh OBRIGATÓRIO -> confirma o novo
// valor efetivo. Nunca confia só na resposta do POST.
// =====================================================================

test("reduceLeverageSafely: 10 -> 2, conta flat, sem ordens -> setLeverage mockado + refresh obrigatório confirma o novo valor efetivo", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);

  t.mock.method(bybit, "getWalletBalance", GOOD_READS.getWalletBalance);
  t.mock.method(bybit, "getPositions", async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "10", tradeMode: 0, positionIdx: 0 }]);
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  // snapshot PRÉ-mutação, efetiva "10" -- é o que o gate lê de dentro de
  // bybit.setLeverage(), do disco isolado deste teste (CRYPTO10_DEMO_RUNTIME_DIR).
  await refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" });

  let postCalls = 0;
  let capturedBody;
  t.mock.method(axios, "post", async (url, body) => {
    postCalls++;
    capturedBody = JSON.parse(body);
    return { data: { retCode: 0, result: {} } };
  });

  // Leitura de CONFIRMAÇÃO (segunda captura, obrigatória, DEPOIS do POST) --
  // mostra "2", já refletindo a mutação.
  t.mock.method(bybit, "getPositions", async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "2", tradeMode: 0, positionIdx: 0 }]);

  const confirmed = await reduceLeverageSafely({ env: process.env, symbol: "SOLUSDT", leverage: "2" });
  assert.equal(postCalls, 1);
  assert.equal(capturedBody.buyLeverage, "2");
  assert.equal(capturedBody.sellLeverage, "2");
  assert.equal(confirmed.symbolState.effectiveLeverage, "2");
});

test("reduceLeverageSafely: POST mockado retorna sucesso mas a leitura de confirmação ainda mostra o valor antigo -> LeverageReductionNotConfirmedError, nunca confia só na resposta do POST", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);

  t.mock.method(bybit, "getWalletBalance", GOOD_READS.getWalletBalance);
  t.mock.method(bybit, "getPositions", async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "10", tradeMode: 0, positionIdx: 0 }]);
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  await refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" });

  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  // getPositions NÃO é remockado depois do POST -- a leitura de confirmação
  // ainda devolve "10", divergindo do "2" solicitado (simula um POST que
  // "diz" sucesso sem o efeito real ter colado do lado da Bybit).

  await assert.rejects(
    () => reduceLeverageSafely({ env: process.env, symbol: "SOLUSDT", leverage: "2" }),
    (err) => {
      assert.equal(err.code, "DEMO_LEVERAGE_REDUCTION_NOT_CONFIRMED");
      assert.ok(err instanceof LeverageReductionNotConfirmedError);
      assert.equal(err.requestedLeverage, "2");
      assert.equal(err.observedLeverage, "10");
      return true;
    }
  );
  assert.equal(postCalls, 1, "o POST realmente aconteceu (mockado) -- a rejeição vem da confirmação pós-mutação, não da tentativa em si");
});

test("reduceLeverageSafely: aumento (2 -> 10) -> bloqueado pelo gate ANTES de qualquer axios.post, refresh de confirmação nunca chega a rodar", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);

  t.mock.method(bybit, "getWalletBalance", GOOD_READS.getWalletBalance);
  t.mock.method(bybit, "getPositions", async () => [{ symbol: "SOLUSDT", side: "", size: "0", leverage: "2", tradeMode: 0, positionIdx: 0 }]);
  t.mock.method(bybit, "getOpenOrders", GOOD_READS.getOpenOrders);
  t.mock.method(bybit, "getInstrumentInfo", GOOD_READS.getInstrumentInfo);

  await refreshDemoAccountSnapshot({ env: process.env, symbol: "SOLUSDT" });

  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  await assert.rejects(() => reduceLeverageSafely({ env: process.env, symbol: "SOLUSDT", leverage: "10" }), (err) => {
    assert.equal(err.code, "DEMO_SAFE_LEVERAGE_REDUCTION_BLOCKED");
    assert.equal(err.reason, "leverage_reduction_exceeds_demo_ceiling");
    return true;
  });
  assert.equal(postCalls, 0);
});

test("nenhum teste deste arquivo importa net/http diretamente -- só axios, sempre mockado", () => {
  const fs = require("fs");
  const firstTestLine = fs
    .readFileSync(__filename, "utf8")
    .split("\n")
    .findIndex((line) => line.startsWith("test("));
  const importsOnly = fs.readFileSync(__filename, "utf8").split("\n").slice(0, firstTestLine).join("\n");
  for (const token of ["node:http", '"http"', "node:net", '"net"', "better-sqlite3"]) {
    assert.ok(!importsOnly.includes(token), `imports deste arquivo não deveriam mencionar "${token}"`);
  }
});

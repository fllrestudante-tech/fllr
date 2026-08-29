const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const bybit = require("../lib/bybit");
const { mockDemoAuth } = require("./helpers/demoAuthMocks");

// setTradingStop é uma chamada PRIVADA (lib/tradingExecutionGate.js bloqueia
// antes de qualquer request) -- os testes que a exercitam aqui só validam a
// forma do corpo da requisição contra um transporte inteiramente mockado
// (t.mock.method em axios.post, nenhuma rede real), por isso habilitar o
// gate só neste processo de teste é seguro. Restaurado sempre depois, nunca
// vaza pra outros arquivos de teste.
function enableTradingExecutionForTest(t) {
  const prev = process.env.TRADING_EXECUTION_ENABLED;
  process.env.TRADING_EXECUTION_ENABLED = "true";
  t.after(() => {
    if (prev === undefined) delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = prev;
  });
}

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

// {start,end} são novos parâmetros opcionais (backfill de candles/funding/OI
// após uma queda de conectividade) -- t.mock.method (nativo do node:test,
// sem lib nova) intercepta axios.get pra confirmar a querystring real
// enviada, já que lib/bybit.js não injeta o cliente HTTP.
test("getKlines: sem {start,end} gera a mesma querystring de sempre (retrocompat)", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getKlines("BTCUSDT", "1", 500);
  assert.doesNotMatch(capturedUrl, /start=|end=/);
});

test("getKlines: com {start,end} inclui ambos na querystring", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getKlines("BTCUSDT", "1", 500, { start: 1000, end: 2000 });
  assert.match(capturedUrl, /start=1000/);
  assert.match(capturedUrl, /end=2000/);
});

test("getFundingHistory: sem {start,end} gera a mesma querystring de sempre (retrocompat)", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getFundingHistory("BTCUSDT", 1);
  assert.doesNotMatch(capturedUrl, /startTime=|endTime=/);
});

test("getFundingHistory: com {start,end} inclui startTime/endTime na querystring", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getFundingHistory("BTCUSDT", 1, { start: 1000, end: 2000 });
  assert.match(capturedUrl, /startTime=1000/);
  assert.match(capturedUrl, /endTime=2000/);
});

test("getOpenInterest: sem {start,end} gera a mesma querystring de sempre (retrocompat)", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getOpenInterest("BTCUSDT", "5min", 1);
  assert.doesNotMatch(capturedUrl, /startTime=|endTime=/);
});

test("setTradingStop: envia stopLoss no corpo da requisição (Fase D3, break even)", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  // stopLoss=65000 precisa classificar como PROTECTIVE_STOP (tightening) --
  // posição Buy com stop anterior bem mais baixo (1) satisfaz isso, sem
  // precisar de ARMED_DEMO/snapshot (ação defensiva).
  mockDemoAuth(t, { localState: { isOpened: true, side: "Buy", qty: 1, entryPrice: 60000, stopLossPrice: 1 } });
  let capturedBody;
  t.mock.method(axios, "post", async (url, body) => {
    capturedBody = JSON.parse(body);
    return { data: { retCode: 0, result: {} } };
  });
  await bybit.setTradingStop({ symbol: "BTCUSDT", stopLoss: 65000 });
  assert.equal(capturedBody.stopLoss, "65000");
  assert.equal(capturedBody.trailingStop, undefined);
  assert.equal(capturedBody.activePrice, undefined);
});

test("setTradingStop: envia trailingStop/activePrice quando fornecidos (Fase D4)", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  // stopLoss ausente do payload -> PROTECTIVE_STOP incondicional (ver
  // lib/demoOrderGate.js::classifyStopChange), nenhuma posição necessária.
  mockDemoAuth(t, {});
  let capturedBody;
  t.mock.method(axios, "post", async (url, body) => {
    capturedBody = JSON.parse(body);
    return { data: { retCode: 0, result: {} } };
  });
  await bybit.setTradingStop({ symbol: "BTCUSDT", trailingStop: 150, activePrice: 66000 });
  assert.equal(capturedBody.trailingStop, "150");
  assert.equal(capturedBody.activePrice, "66000");
  assert.equal(capturedBody.stopLoss, undefined);
});

test("getOpenInterest: com {start,end} inclui startTime/endTime na querystring", async (t) => {
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [] } } };
  });
  await bybit.getOpenInterest("BTCUSDT", "5min", 1, { start: 1000, end: 2000 });
  assert.match(capturedUrl, /startTime=1000/);
  assert.match(capturedUrl, /endTime=2000/);
});

// =====================================================================
// Gate financeiro (lib/tradingExecutionGate.js) -- prova de que NENHUMA
// chamada privada escapa quando TRADING_EXECUTION_ENABLED não está
// habilitado, mesmo com BYBIT_DEMO/credenciais presentes (config.js real
// desta máquina já está em demo=true com credenciais no .env -- é
// exatamente esse ambiente real, sem o gate setado, que estes testes
// exercitam). Nenhuma chamada de rede é esperada em nenhum destes casos.
// =====================================================================

function withGateDisabledForTest(t) {
  const prev = process.env.TRADING_EXECUTION_ENABLED;
  delete process.env.TRADING_EXECUTION_ENABLED;
  t.after(() => {
    if (prev === undefined) delete process.env.TRADING_EXECUTION_ENABLED;
    else process.env.TRADING_EXECUTION_ENABLED = prev;
  });
}

test("setLeverage: bloqueado ANTES de qualquer chamada de rede quando o gate financeiro não está habilitado", async (t) => {
  withGateDisabledForTest(t);
  let getCalls = 0;
  let postCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  await assert.rejects(() => bybit.setLeverage("BTCUSDT", 5), (err) => {
    assert.equal(err.code, "TRADING_EXECUTION_BLOCKED");
    return true;
  });
  assert.equal(postCalls, 0, "setLeverage nunca deveria ter chegado a chamar axios.post");
  assert.equal(getCalls, 0);
});

test("chamadas privadas (placeOrder/getWalletBalance/getPositions/getClosedPnl/setTradingStop/applyDemoFunds): todas bloqueadas sem o gate, nenhuma toca a rede", async (t) => {
  withGateDisabledForTest(t);
  let getCalls = 0;
  let postCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    return { data: { retCode: 0, result: { list: [{ totalEquity: "1", totalAvailableBalance: "1" }] } } };
  });
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  const privateCalls = [
    () => bybit.placeOrder({ side: "Buy", qty: 1 }),
    () => bybit.getWalletBalance(),
    () => bybit.getPositions("BTCUSDT"),
    () => bybit.getClosedPnl("BTCUSDT", 1),
    () => bybit.setTradingStop({ symbol: "BTCUSDT", stopLoss: 1 }),
    () => bybit.applyDemoFunds("USDT", 100),
  ];

  for (const call of privateCalls) {
    await assert.rejects(call, (err) => {
      assert.equal(err.code, "TRADING_EXECUTION_BLOCKED");
      return true;
    });
  }
  assert.equal(getCalls, 0, "nenhuma chamada privada deveria ter tocado axios.get");
  assert.equal(postCalls, 0, "nenhuma chamada privada deveria ter tocado axios.post");
});

test("getInstrumentInfo (pública) continua funcionando sem o gate -- o bloqueio é só pras chamadas privadas", async (t) => {
  withGateDisabledForTest(t);
  t.mock.method(axios, "get", async () => ({
    data: { retCode: 0, result: { list: [{ lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001" }, priceFilter: { tickSize: "0.01" } }] } },
  }));
  const info = await bybit.getInstrumentInfo("ETHUSDT_TESTE_GATE"); // símbolo só pra não colidir com o cache de outro teste
  assert.equal(info.tickSize, "0.01");
});

// =====================================================================
// assertPrivateReadAuthorized / assertPrivateMutationAuthorized (Bloqueador 2)
// -- leitura privada demo != mutação financeira demo, e o gate canônico
// de ordem (lib/demoOrderGate.js) fica DENTRO de privatePost -- provado
// aqui através das funções REAIS de transporte (getWalletBalance/
// placeOrder/setLeverage), nunca só chamando o gate isoladamente.
// =====================================================================

test("assertPrivateReadAuthorized: perfil demo + DEMO_PRIVATE_READ_ENABLED=true -> não lança, SEM TRADING_EXECUTION_ENABLED", () => {
  const env = validDemoEnv({ DEMO_PRIVATE_READ_ENABLED: "true" });
  assert.equal(env.TRADING_EXECUTION_ENABLED, undefined);
  assert.doesNotThrow(() => bybit.assertPrivateReadAuthorized(env));
});

test("assertPrivateReadAuthorized: TRADING_EXECUTION_ENABLED=true continua autorizando leitura em qualquer perfil (comportamento pré-existente preservado)", () => {
  assert.doesNotThrow(() => bybit.assertPrivateReadAuthorized({ TRADING_EXECUTION_ENABLED: "true" }));
});

test("assertPrivateReadAuthorized: sem gate forte E sem DEMO_PRIVATE_READ_ENABLED -> bloqueia", () => {
  assert.throws(() => bybit.assertPrivateReadAuthorized({}));
});

test("integração REAL via bybit.getWalletBalance(): DEMO_PRIVATE_READ_ENABLED=true autoriza a LEITURA sem TRADING_EXECUTION_ENABLED, e nunca libera bybit.placeOrder() na mesma configuração (Bloqueador 2)", async (t) => {
  withEnv(t, validDemoEnv({ DEMO_PRIVATE_READ_ENABLED: "true" }));
  mockDemoAuth(t, {}); // getWalletBalance grava outcome de telemetria -- mockado pra nunca tocar runtime/demo/ real

  let getCalls = 0;
  let postCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    return { data: { retCode: 0, result: { list: [{ totalEquity: "1", totalAvailableBalance: "1" }] } } };
  });
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  const balance = await bybit.getWalletBalance("UNIFIED");
  assert.equal(balance.totalEquity, 1);
  assert.equal(getCalls, 1, "leitura deveria ter alcançado a rede (mockada)");

  await assert.rejects(
    () => bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-001" }),
    (err) => {
      assert.equal(err.code, "TRADING_EXECUTION_BLOCKED", "leitura habilitada NUNCA deveria, por si só, liberar mutação");
      return true;
    }
  );
  assert.equal(postCalls, 0, "mutação deveria ter sido bloqueada ANTES de qualquer axios.post");
});

test("integração REAL via bybit.placeOrder(): perfil demo com env inválido bloqueia ANTES de qualquer rede, mesmo com o gate financeiro habilitado", async (t) => {
  withEnv(t, validDemoEnv({ BYBIT_TESTNET: "true" })); // inválido -- exige exatamente "false"
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: true, snapshot: {} }); // mesmo armado/com snapshot, o env inválido bloqueia primeiro

  let getCalls = 0;
  let postCalls = 0;
  t.mock.method(axios, "get", async () => {
    getCalls++;
    return { data: { retCode: 0, result: { list: [{ totalEquity: "1", totalAvailableBalance: "1" }] } } };
  });
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  await assert.rejects(
    () => bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-002" }),
    (err) => {
      assert.equal(err.code, "DEMO_FLAG_INVALID");
      return true;
    }
  );
  assert.equal(postCalls, 0, "nenhuma chamada privada deveria ter tocado axios.post");
  assert.equal(getCalls, 0);
});

test("integração REAL via bybit.placeOrder(): perfil demo válido, SEM ARMED_DEMO -> bloqueado, zero rede", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: false });
  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  await assert.rejects(
    () => bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-003" }),
    (err) => {
      assert.equal(err.code, "NEW_EXPOSURE_BLOCKED");
      return true;
    }
  );
  assert.equal(postCalls, 0);
});

test("integração REAL via bybit.placeOrder(): perfil demo válido + ARMED_DEMO + snapshot fresco + dentro dos limites -> alcança a rede exatamente 1 vez", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: true, snapshot: {} });

  let postCalls = 0;
  let capturedBody;
  t.mock.method(axios, "post", async (url, body) => {
    postCalls++;
    capturedBody = JSON.parse(body);
    return { data: { retCode: 0, result: { orderId: "fake-order-id" } } };
  });

  const res = await bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-004" });
  assert.equal(postCalls, 1);
  assert.equal(capturedBody.orderLinkId, "test-order-link-004");
  assert.equal(capturedBody.qty, "1"); // decimal-safe -- string exata, nunca reconstruída via Number (Bloqueador 1)
  assert.equal(res.orderId, "fake-order-id");
});

test("integração REAL via bybit.placeOrder(): mesmo orderLinkId reutilizado numa segunda chamada -> bloqueado, sem segunda chamada de rede (idempotência)", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: true, snapshot: {} });

  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });

  const order = { symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-005" };
  await bybit.placeOrder(order);
  assert.equal(postCalls, 1);
  await assert.rejects(() => bybit.placeOrder(order), (err) => {
    assert.equal(err.code, "DEMO_ORDER_LINK_ID_REUSED");
    return true;
  });
  assert.equal(postCalls, 1, "segunda tentativa com o mesmo orderLinkId nunca deveria ter tocado a rede de novo");
});

test("integração REAL via bybit.setLeverage(): SEM ARMED_DEMO bloqueia -- leverage é tratado como aumento de exposição", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: false });
  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  await assert.rejects(() => bybit.setLeverage("SOLUSDT", 2), (err) => {
    assert.equal(err.code, "NEW_EXPOSURE_BLOCKED");
    return true;
  });
  assert.equal(postCalls, 0);
});

test("integração REAL: nenhum endpoint diferente de api-demo.bybit.com pode ser usado no perfil demo -- endpoint é recomputado/validado a cada chamada mutável (Bloqueador 8)", async (t) => {
  withEnv(t, validDemoEnv({ BYBIT_DEMO: "false", BYBIT_TESTNET: "true" })); // resolveria pra testnet
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: true, snapshot: {} });
  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  await assert.rejects(() => bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-006" }), (err) => {
    assert.equal(err.code, "DEMO_FLAG_INVALID");
    return true;
  });
  assert.equal(postCalls, 0);
});

test("integração REAL: a URL usada pelo axios.post é EXATAMENTE a devolvida pelo resolvedor estrito (Bloqueador 8) -- nunca diverge", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: true, snapshot: {} });
  let capturedUrl;
  t.mock.method(axios, "post", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: {} } };
  });
  await bybit.placeOrder({ symbol: "SOLUSDT", side: "Buy", qty: 1, price: 40, stopLoss: 38, orderLinkId: "test-order-link-007" });
  assert.equal(capturedUrl, `${bybit.resolvePrivateBaseUrl(process.env)}/v5/order/create`);
});

// =====================================================================
// Bloqueador 7 -- TRADING_EXECUTION_ENABLED=true NUNCA é suficiente
// sozinho pra autorizar mutação, em NENHUM perfil diferente de "demo".
// Comportamento DELIBERADAMENTE DIFERENTE do que existia antes desta
// rodada (a versão anterior deste teste, que afirmava o oposto, foi
// removida -- preservar mutação fora do demo é exatamente o que este
// projeto de segurança existe pra eliminar).
// =====================================================================

for (const [label, profileOverrides, expectedCode] of [
  ["perfil safe", { SUPERVISOR_PROFILE: "safe" }, "DEMO_ORDER_WRONG_PROFILE"],
  ["perfil ausente", { SUPERVISOR_PROFILE: undefined }, "DEMO_ORDER_WRONG_PROFILE"],
  ["perfil inválido", { SUPERVISOR_PROFILE: "algo-que-nao-existe" }, "SUPERVISOR_PROFILE_INVALID"], // não reconhecido -- bloqueia com um código diferente, mas bloqueia igual, ANTES de qualquer rede
  ["perfil testnet-like (BYBIT_TESTNET=true, fora do demo)", { SUPERVISOR_PROFILE: "safe", BYBIT_TESTNET: "true" }, "DEMO_ORDER_WRONG_PROFILE"],
]) {
  test(`integração via privatePost: ${label} + TRADING_EXECUTION_ENABLED=true -> mutação SEMPRE bloqueada ANTES de HMAC/Axios (Bloqueador 7)`, async (t) => {
    const prev = {};
    for (const key of Object.keys(profileOverrides)) prev[key] = process.env[key];
    for (const [key, value] of Object.entries(profileOverrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    t.after(() => {
      for (const key of Object.keys(profileOverrides)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
    enableTradingExecutionForTest(t);
    mockDemoAuth(t, {}); // recordLastDecision é chamado mesmo no bloqueio -- nunca deve tocar runtime/demo/ real em teste
    let postCalls = 0;
    t.mock.method(axios, "post", async () => {
      postCalls++;
      return { data: { retCode: 0, result: {} } };
    });
    await assert.rejects(
      () => bybit.setTradingStop({ symbol: "BTCUSDT", stopLoss: 1 }),
      (err) => {
        assert.equal(err.code, expectedCode);
        return true;
      }
    );
    assert.equal(postCalls, 0, `${label}: mutação deveria ter bloqueado ANTES de qualquer axios.post, mesmo com TRADING_EXECUTION_ENABLED=true`);
  });
}

// =====================================================================
// getOpenOrders/cancelOrder/cancelAllOrders (Bloqueadores 4, 9) --
// cancel/reduce nunca exigem ARMED_DEMO, só perfil/credenciais/gate
// financeiro demo.
// =====================================================================

test("integração REAL via bybit.getOpenOrders(): READ -- alcança a rede mockada, nunca exige ARMED_DEMO", async (t) => {
  withEnv(t, validDemoEnv({ DEMO_PRIVATE_READ_ENABLED: "true" }));
  mockDemoAuth(t, {});
  let capturedUrl;
  t.mock.method(axios, "get", async (url) => {
    capturedUrl = url;
    return { data: { retCode: 0, result: { list: [{ symbol: "SOLUSDT", side: "Buy", qty: "1", price: "20", reduceOnly: false, orderLinkId: "x" }] } } };
  });
  const orders = await bybit.getOpenOrders("SOLUSDT");
  assert.equal(orders.length, 1);
  assert.match(capturedUrl, /\/v5\/order\/realtime/);
});

test("integração REAL via bybit.cancelOrder()/cancelAllOrders(): SEM ARMED_DEMO -- ainda assim permitido (CANCEL nunca aumenta exposição)", async (t) => {
  withEnv(t, validDemoEnv());
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, { armed: false }); // BLOCK_NEW_EXPOSURE explícito -- nunca ARMED_DEMO
  let postCalls = 0;
  const urls = [];
  t.mock.method(axios, "post", async (url) => {
    postCalls++;
    urls.push(url);
    return { data: { retCode: 0, result: {} } };
  });
  await bybit.cancelOrder({ symbol: "SOLUSDT", orderLinkId: "algum-id" });
  await bybit.cancelAllOrders("SOLUSDT");
  assert.equal(postCalls, 2);
  assert.match(urls[0], /\/v5\/order\/cancel$/);
  assert.match(urls[1], /\/v5\/order\/cancel-all$/);
});

test("integração REAL via bybit.cancelOrder(): fora do perfil demo -- bloqueado igual a qualquer outra mutação (Bloqueador 7)", async (t) => {
  const prevProfile = process.env.SUPERVISOR_PROFILE;
  process.env.SUPERVISOR_PROFILE = "safe";
  enableTradingExecutionForTest(t);
  mockDemoAuth(t, {}); // recordLastDecision é chamado mesmo no bloqueio -- nunca deve tocar runtime/demo/ real em teste
  t.after(() => {
    if (prevProfile === undefined) delete process.env.SUPERVISOR_PROFILE;
    else process.env.SUPERVISOR_PROFILE = prevProfile;
  });
  let postCalls = 0;
  t.mock.method(axios, "post", async () => {
    postCalls++;
    return { data: { retCode: 0, result: {} } };
  });
  await assert.rejects(() => bybit.cancelOrder({ symbol: "SOLUSDT", orderLinkId: "x" }), (err) => {
    assert.equal(err.code, "DEMO_ORDER_WRONG_PROFILE");
    return true;
  });
  assert.equal(postCalls, 0);
});

// =====================================================================
// Inspeção de exports -- Bloqueador 2: nenhuma função pública aceita
// parâmetro de override capaz de trocar caminho de kill switch/ledger/
// snapshot/clock/estado. Prova por INSPEÇÃO DE CÓDIGO-FONTE (nunca
// confia só em "não vi nenhum teste passando isso") -- se alguém
// reintroduzir __demoTestOverrides ou qualquer parâmetro parecido, este
// teste quebra imediatamente.
// =====================================================================

test("lib/bybit.js: nenhuma função pública tem parâmetro de override (__demoTestOverrides ou similar)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "bybit.js"), "utf8");
  assert.ok(!source.includes("__demoTestOverrides"), "lib/bybit.js não deveria mais conter nenhuma menção a __demoTestOverrides");
  assert.ok(!source.includes("overrides"), "lib/bybit.js não deveria mais aceitar um parâmetro genérico de overrides em nenhuma função de transporte");
});

test("lib/demoOrderGate.js: assertDemoOrderAllowed não aceita killSwitchPath/ledgerPath/outcomesPath/loadState/lockPath/snapshotPath como parâmetro (Bloqueador 2)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "demoOrderGate.js"), "utf8");
  const fnMatch = source.match(/function assertDemoOrderAllowed\(([^)]*)\)/s);
  assert.ok(fnMatch, "assertDemoOrderAllowed deveria existir com uma assinatura de função nomeada simples");
  const signature = fnMatch[1];
  for (const forbidden of ["killSwitchPath", "ledgerPath", "outcomesPath", "loadState", "lockPath", "snapshotPath", "lastDecisionPath"]) {
    assert.ok(!signature.includes(forbidden), `assertDemoOrderAllowed não deveria aceitar "${forbidden}" na assinatura pública -- assinatura atual: ${signature.trim()}`);
  }
});

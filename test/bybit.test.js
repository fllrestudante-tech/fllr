const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const bybit = require("../lib/bybit");

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
  enableTradingExecutionForTest(t);
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
  enableTradingExecutionForTest(t);
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

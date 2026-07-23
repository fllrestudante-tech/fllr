const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const bybit = require("../lib/bybit");

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

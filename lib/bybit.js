const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");
const { withRetry } = require("./httpRetry");

const BASE_URL = config.bybit.demo
  ? "https://api-demo.bybit.com"
  : config.bybit.testnet
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

const RECV_WINDOW = "5000";

function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function sign(payloadString, timestamp) {
  const raw = timestamp + config.bybit.apiKey + RECV_WINDOW + payloadString;
  return crypto.createHmac("sha256", config.bybit.apiSecret).update(raw).digest("hex");
}

function authHeaders(payloadString) {
  const timestamp = Date.now().toString();
  return {
    "X-BAPI-API-KEY": config.bybit.apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "X-BAPI-SIGN": sign(payloadString, timestamp),
    "Content-Type": "application/json",
  };
}

// fn é re-executada do zero a cada tentativa de retry (dentro de withRetry) —
// necessário porque timestamp/assinatura HMAC só são válidos por RECV_WINDOW.
async function privateGet(path, params = {}) {
  return withRetry(async () => {
    const qs = buildQueryString(params);
    const headers = authHeaders(qs);
    const url = qs ? `${BASE_URL}${path}?${qs}` : `${BASE_URL}${path}`;
    const { data } = await axios.get(url, { headers });
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${path} retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result;
  });
}

async function privatePost(path, body = {}) {
  return withRetry(async () => {
    const bodyString = JSON.stringify(body);
    const headers = authHeaders(bodyString);
    const { data } = await axios.post(`${BASE_URL}${path}`, bodyString, { headers });
    if (data.retCode !== 0) {
      throw new Error(`Bybit ${path} retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result;
  });
}

// -------- Público (sem autenticação) --------

const instrumentInfoCache = {};

// qtyStep/tickSize ficam como string (precisão original da Bybit) — arredondar
// como float perde casas decimais e gera o mesmo erro "Qty invalid"/"Price invalid"
// que essa função existe pra evitar.
async function getInstrumentInfo(symbol = config.symbol) {
  if (instrumentInfoCache[symbol]) return instrumentInfoCache[symbol];
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol });
    const { data } = await axios.get(`${BASE_URL}/v5/market/instruments-info?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getInstrumentInfo retCode=${data.retCode} ${data.retMsg}`);
    }
    const info = data.result.list[0];
    const parsed = {
      qtyStep: info.lotSizeFilter.qtyStep,
      minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
      tickSize: info.priceFilter.tickSize,
    };
    instrumentInfoCache[symbol] = parsed;
    return parsed;
  });
}

async function getKlines(symbol = config.symbol, interval = config.interval, limit = 500) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, interval, limit });
    const { data } = await axios.get(`${BASE_URL}/v5/market/kline?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getKlines retCode=${data.retCode} ${data.retMsg}`);
    }
    // Bybit retorna mais recente primeiro — inverter para ficar cronológico como o resto do código espera
    // list item: [startTime, open, high, low, close, volume, turnover]
    return data.result.list
      .slice()
      .reverse()
      .map((c) => [Number(c[0]), c[1], c[2], c[3], c[4], c[5]]);
  });
}

async function getFundingHistory(symbol = config.symbol, limit = 1) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, limit });
    const { data } = await axios.get(`${BASE_URL}/v5/market/funding/history?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getFundingHistory retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{symbol, fundingRate, fundingRateTimestamp}], mais recente primeiro
  });
}

async function getOpenInterest(symbol = config.symbol, intervalTime = "5min", limit = 1) {
  return withRetry(async () => {
    const qs = buildQueryString({ category: config.bybit.category, symbol, intervalTime, limit });
    const { data } = await axios.get(`${BASE_URL}/v5/market/open-interest?${qs}`);
    if (data.retCode !== 0) {
      throw new Error(`Bybit getOpenInterest retCode=${data.retCode} ${data.retMsg}`);
    }
    return data.result.list; // [{openInterest, timestamp}], mais recente primeiro
  });
}

// -------- Privado (autenticado) --------

async function getWalletBalance(accountType = "UNIFIED") {
  const result = await privateGet("/v5/account/wallet-balance", { accountType });
  const account = result.list && result.list[0];
  if (!account) throw new Error("Bybit getWalletBalance: resposta vazia");
  return {
    totalEquity: parseFloat(account.totalEquity),
    totalAvailableBalance: parseFloat(account.totalAvailableBalance),
    raw: account,
  };
}

async function getPositions(symbol = config.symbol) {
  const result = await privateGet("/v5/position/list", { category: config.bybit.category, symbol });
  return result.list || [];
}

// Usado para descobrir o PnL real de um trade fechado automaticamente pelo
// stop-loss/take-profit anexado à ordem (Bybit executa isso no servidor —
// o bot só fica sabendo checando esse endpoint ou o position/list ficando vazio).
async function getClosedPnl(symbol = config.symbol, limit = 1) {
  const result = await privateGet("/v5/position/closed-pnl", { category: config.bybit.category, symbol, limit });
  return result.list || [];
}

async function setLeverage(symbol = config.symbol, leverage = config.leverageMax) {
  return privatePost("/v5/position/set-leverage", {
    category: config.bybit.category,
    symbol,
    buyLeverage: String(leverage),
    sellLeverage: String(leverage),
  });
}

/**
 * side: "Buy" | "Sell"
 * stopLoss / takeProfit: preços absolutos (não %), opcional
 */
async function placeOrder({ symbol = config.symbol, side, qty, stopLoss, takeProfit, reduceOnly = false }) {
  const body = {
    category: config.bybit.category,
    symbol,
    side,
    orderType: "Market",
    qty: String(qty),
    timeInForce: "IOC",
    reduceOnly,
  };
  if (stopLoss) body.stopLoss = String(stopLoss);
  if (takeProfit) body.takeProfit = String(takeProfit);
  return privatePost("/v5/order/create", body);
}

// Só funciona em Demo Trading (config.bybit.demo). Máximos por chamada: BTC 15, ETH 200, USDT/USDC 100000. Rate limit: 1/min.
async function applyDemoFunds(coin, amount) {
  return privatePost("/v5/account/demo-apply-money", {
    adjustType: 0,
    utaDemoApplyMoney: [{ coin, amountStr: String(amount) }],
  });
}

module.exports = {
  BASE_URL,
  getInstrumentInfo,
  getKlines,
  getFundingHistory,
  getOpenInterest,
  getWalletBalance,
  getPositions,
  getClosedPnl,
  setLeverage,
  placeOrder,
  applyDemoFunds,
};

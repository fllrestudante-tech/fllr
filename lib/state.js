const fs = require("fs");
const config = require("../config");
const bybit = require("./bybit");
const { atomicWriteJsonSync } = require("./atomicWrite");

const DEFAULT_STATE = {
  isOpened: false,
  side: null, // "Buy" | "Sell"
  entryPrice: null,
  qty: null,
  lastSignal: null,
  lastTradeTime: 0,
  dailyLoss: 0,
  dailyLossDate: null, // "YYYY-MM-DD" (UTC) — usado pelo circuit breaker diário
  openedAt: null, // ms epoch de quando a posição atual foi aberta -- alimenta hold time (Trading Health) e, desde a Fase D1, o time stop (lib/tradeLifecycle.js::isTimeStop)
  consecutiveLosses: 0, // Fase D2 (Circuit Breaker) -- zera em qualquer trade lucrativo
  circuitBreakerUntil: null, // ms epoch -- lib/risk.js::canExecute bloqueia novas entradas enquanto now < isto
  stopLossPrice: null, // Fase D3 -- preço do stop original (mesmo enviado em placeOrder), usado como referência de R (risco por trade) pra break even/trailing/TP
  breakEvenApplied: false, // Fase D3 -- evita reenviar setTradingStop todo ciclo depois que o stop já foi movido pra entrada
  trailingActivated: false, // Fase D4 -- evita reenviar setTradingStop (trailing) todo ciclo depois de ativado
  trailingDistance: null, // Fase D4 -- distância (ATR × multiplicador) travada no momento da ativação, só informativo/log
};

function ensureDataDir() {
  if (!fs.existsSync(config.paths.dataDir)) {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(config.paths.stateFile)) {
    return { ...DEFAULT_STATE };
  }
  try {
    const raw = fs.readFileSync(config.paths.stateFile, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (err) {
    console.error("⚠️  state.json corrompido, recomeçando do zero:", err.message);
    return { ...DEFAULT_STATE };
  }
}

function save(state) {
  ensureDataDir();
  atomicWriteJsonSync(config.paths.stateFile, state);
}

/**
 * Compara o estado local persistido contra a posição real na Bybit.
 * A posição real da corretora sempre vence em caso de divergência —
 * o bot anterior perdia todo o estado em qualquer restart/crash porque
 * só guardava isOpened em memória.
 */
async function reconcile(localState) {
  const positions = await bybit.getPositions(config.symbol);
  const openPosition = positions.find((p) => parseFloat(p.size) > 0);

  const reconciled = { ...localState };
  let closedExternally = false; // true = tínhamos posição local e ela sumiu na corretora (provável fill de SL/TP)

  if (openPosition) {
    const realIsOpened = true;
    const realSide = openPosition.side; // "Buy" | "Sell"
    const realQty = parseFloat(openPosition.size);
    const realEntry = parseFloat(openPosition.avgPrice);

    if (
      localState.isOpened !== realIsOpened ||
      localState.side !== realSide ||
      localState.qty !== realQty
    ) {
      console.warn(
        `⚠️  Divergência de estado detectada. Local: isOpened=${localState.isOpened} side=${localState.side} qty=${localState.qty} | Real (Bybit): side=${realSide} qty=${realQty} entry=${realEntry}. Usando o estado real da corretora.`
      );
    }

    reconciled.isOpened = true;
    reconciled.side = realSide;
    reconciled.qty = realQty;
    reconciled.entryPrice = realEntry;
  } else if (localState.isOpened) {
    console.warn(
      "⚠️  Posição local estava aberta e não existe mais na Bybit — provável fechamento por stop-loss/take-profit. Corrigindo estado para fechado."
    );
    closedExternally = true;
    reconciled.isOpened = false;
    reconciled.side = null;
    reconciled.qty = null;
    reconciled.entryPrice = null;
    reconciled.stopLossPrice = null;
    reconciled.breakEvenApplied = false;
    reconciled.trailingActivated = false;
    reconciled.trailingDistance = null;
  }

  save(reconciled);
  return { state: reconciled, closedExternally };
}

function resetDailyLossIfNewDay(state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyLossDate !== today) {
    state.dailyLoss = 0;
    state.dailyLossDate = today;
  }
  return state;
}

module.exports = { load, save, reconcile, resetDailyLossIfNewDay, DEFAULT_STATE };

const config = require("./config");
const bybit = require("./lib/bybit");
const state = require("./lib/state");
const signal = require("./lib/signal");
const risk = require("./lib/risk");
const logger = require("./lib/logger");
const backtest = require("./lib/backtest");
const backoff = require("./lib/backoff");
const { createHealthRegistry } = require("./lib/health");
const healthChecks = require("./lib/healthChecks");
const alerts = require("./lib/alerts");

let botState;
let instrumentInfo;
let consecutiveFailures = 0;

const healthRegistry = createHealthRegistry();
healthRegistry.registerCheck("bybit", healthChecks.checkBybit);
healthRegistry.registerCheck("bybit_collector", healthChecks.checkCollector);
healthRegistry.registerCheck("fear_greed_collector", healthChecks.checkFearGreed);
healthRegistry.registerCheck("btc_dominance_collector", healthChecks.checkBtcDominance);
healthRegistry.registerCheck("knowledge_collector", healthChecks.checkKnowledgeCollector);
healthRegistry.registerCheck("metrics_sampler", healthChecks.checkMetricsSampler);
healthRegistry.registerCheck("supervisor", healthChecks.checkSupervisor);
healthRegistry.registerCheck("backtest", healthChecks.checkBacktest);
healthRegistry.registerCheck("telegram_radar", healthChecks.checkTelegramRadar);
healthRegistry.registerCheck("scanner", healthChecks.notImplemented);
healthRegistry.registerCheck("banco_de_dados", healthChecks.checkDatabase);
healthRegistry.registerCheck("ia", healthChecks.notImplemented);
healthRegistry.registerCheck("workers", healthChecks.notImplemented);

async function runHealthChecks() {
  const results = await healthRegistry.runChecks();
  const transitions = healthRegistry.detectTransitions(results);
  logger.log({ event: "health_check", results });

  if (transitions.length > 0) {
    logger.logAlert({ event: "status_transition", transitions });
    transitions.forEach((t) => console.warn(`🚨 [${t.name}] ${t.from} → ${t.to}`));
    await alerts.alertOnTransitions(transitions).catch((err) => {
      console.error("⚠️  Falha ao enviar alerta:", err.message);
    });
  }
}

async function handleExternalClose(equity) {
  try {
    const closedList = await bybit.getClosedPnl(config.symbol, 1);
    const last = closedList[0];
    if (!last) return;
    const pnlUsd = parseFloat(last.closedPnl);
    const pnlPct = equity > 0 ? pnlUsd / equity : 0;
    const holdMs = botState.openedAt ? Date.now() - botState.openedAt : null; // openedAt some se o bot reiniciou entre a abertura e o fechamento -- honesto reportar null, não fabricar
    risk.registerTradeResult(botState, pnlPct);
    botState.openedAt = null;
    state.save(botState);
    logger.log({
      event: "position_closed_externally",
      pnlUsd,
      pnlPct,
      avgEntryPrice: last.avgEntryPrice,
      avgExitPrice: last.avgExitPrice,
      side: last.side,
      holdMs,
    });
    console.log(`ℹ️  Posição fechada por SL/TP. PnL: $${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
  } catch (err) {
    console.error("⚠️  Não foi possível buscar closed-pnl:", err.message);
  }
}

async function openPosition(side, analysis, equity) {
  const plan = risk.planOrder({ side, price: analysis.price, atr: analysis.atr, equity, params: analysis.params, instrumentInfo });

  if (plan.qty <= 0) {
    console.log("⚠️  Quantidade calculada é zero, ordem não enviada.");
    return;
  }

  const bybitSide = side === "buy" ? "Buy" : "Sell";
  console.log(
    `${side === "buy" ? "🟢" : "🔴"} Sinal de ${side.toUpperCase()}. qty=${plan.qty} stop=${plan.stopLossPrice} alvo=${plan.takeProfitPrice}`
  );

  let res;
  try {
    res = await bybit.placeOrder({
      side: bybitSide,
      qty: plan.qty,
      stopLoss: plan.stopLossPrice,
      takeProfit: plan.takeProfitPrice,
    });
  } catch (err) {
    // Envio da ordem falhou (ex: erro regulatório, saldo insuficiente) — registra
    // lastTradeTime mesmo assim pra ativar o cooldown e não martelar a Bybit todo
    // ciclo com o mesmo pedido que já sabemos que vai falhar de novo.
    botState.lastTradeTime = Date.now();
    state.save(botState);
    logger.log({ event: "order_failed", side: bybitSide, qty: plan.qty, price: analysis.price, error: err.message });
    console.error("⚠️  Falha ao enviar ordem:", err.message);
    return;
  }

  botState.isOpened = true;
  botState.side = bybitSide;
  botState.entryPrice = analysis.price;
  botState.qty = plan.qty;
  botState.lastSignal = side;
  botState.lastTradeTime = Date.now();
  botState.openedAt = Date.now(); // só pra computar hold time no fechamento (Trading Health) -- não influencia nenhuma decisão
  state.save(botState);

  logger.log({
    event: "order_opened",
    side: bybitSide,
    qty: plan.qty,
    price: analysis.price,
    stopLossPrice: plan.stopLossPrice,
    takeProfitPrice: plan.takeProfitPrice,
    reasons: analysis.reasons,
    orderResult: res,
  });
}

async function closePosition(reasonSide, equity) {
  const bybitSide = reasonSide === "buy" ? "Sell" : "Buy"; // ordem oposta à posição atual, reduceOnly
  console.log(`🔁 Sinal reverteu — fechando posição ${botState.side} manualmente.`);
  const holdMs = botState.openedAt ? Date.now() - botState.openedAt : null; // capturado antes do reset abaixo limpar openedAt

  const res = await bybit.placeOrder({
    side: bybitSide,
    qty: botState.qty,
    reduceOnly: true,
  });

  logger.log({ event: "order_closed_manually", side: bybitSide, qty: botState.qty, orderResult: res });

  botState.isOpened = false;
  botState.side = null;
  botState.qty = null;
  botState.entryPrice = null;
  botState.lastTradeTime = Date.now();
  botState.openedAt = null;
  state.save(botState);

  // Fechamento por reversão de sinal também precisa alimentar o circuit breaker
  // de perda diária — sem isso, uma sequência de reversões perdedoras nunca
  // acionava o dailyLossLimitPct, porque só o fechamento por SL/TP (handleExternalClose) registrava.
  try {
    const closedList = await bybit.getClosedPnl(config.symbol, 1);
    const last = closedList[0];
    if (last) {
      const pnlUsd = parseFloat(last.closedPnl);
      const pnlPct = equity > 0 ? pnlUsd / equity : 0;
      risk.registerTradeResult(botState, pnlPct);
      state.save(botState);
      // Antes só dava console.log -- o pnl era calculado mas nunca gravado no
      // log, então fechamentos manuais/por reversão ficavam invisíveis pra
      // qualquer agregação de Trading Health (só position_closed_externally
      // tinha pnl no trades.jsonl). Puramente completude de dado, não muda
      // o que dispara o fechamento nem o tamanho da posição.
      logger.log({
        event: "order_closed_manually_pnl",
        pnlUsd,
        pnlPct,
        avgEntryPrice: last.avgEntryPrice,
        avgExitPrice: last.avgExitPrice,
        side: last.side,
        holdMs,
      });
      console.log(`ℹ️  PnL da posição fechada: $${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
    }
  } catch (err) {
    console.error("⚠️  Não foi possível buscar closed-pnl após fechamento manual:", err.message);
  }
}

async function cycle() {
  try {
    botState = state.resetDailyLossIfNewDay(botState);

    const { state: reconciled, closedExternally } = await state.reconcile(botState);
    botState = reconciled;

    const { totalEquity } = await bybit.getWalletBalance();

    if (closedExternally) {
      await handleExternalClose(totalEquity);
    }

    const candles = await bybit.getKlines(config.symbol, config.interval, 500);
    if (!candles) {
      console.log("⚠️  Sem candles. Pulando ciclo.");
      return;
    }

    const analysis = signal.analyze(candles);
    const time = new Date().toLocaleTimeString();

    console.log("====================================");
    console.log(`⏰ ${time} | Equity: $${totalEquity.toFixed(2)}`);
    console.log(`💰 Price: ${analysis.price}`);
    console.log(`📊 EMA${analysis.params.emaShort}: ${analysis.ema8.toFixed(4)} | EMA${analysis.params.emaLong}: ${analysis.ema56.toFixed(4)}`);
    console.log(`📈 RSI: ${analysis.rsi.toFixed(2)} | StochRSI: ${analysis.stoch.toFixed(2)}`);
    console.log(`📦 Posição aberta? ${botState.isOpened} (${botState.side || "-"})`);
    console.log(`🧠 Sinal: ${analysis.signal} (${analysis.reasons.join(",")})`);

    // Reversão de sinal com posição aberta: fecha a posição atual antes de tudo
    if (botState.isOpened) {
      const opposingSignal =
        (botState.side === "Buy" && analysis.signal === "sell") ||
        (botState.side === "Sell" && analysis.signal === "buy");
      if (opposingSignal) {
        await closePosition(analysis.signal === "sell" ? "buy" : "sell", totalEquity);
      }
    }

    const risk_ = risk.canExecute(analysis.signal, botState);
    console.log(`⚖️ Risk check: ${risk_.ok ? "PASS" : "BLOCK (" + risk_.reason + ")"}`);
    console.log("====================================");

    if ((analysis.signal === "buy" || analysis.signal === "sell") && risk_.ok) {
      await openPosition(analysis.signal, analysis, totalEquity);
    } else {
      logger.log({ event: "wait", signal: analysis.signal, price: analysis.price, reasons: analysis.reasons, riskBlockReason: risk_.reason });
    }
    return true;
  } catch (err) {
    console.error("⚠️  Erro no ciclo principal:", err.message || err);
    logger.log({ event: "error", message: err.message || String(err) });
    return false;
  }
}

async function maybeRunBacktest() {
  try {
    console.log("🔧 Rodando auto-tuning (backtest)...");
    const result = await backtest.run();
    const { baseline, candidate, promoted, reason } = result.lastRun;
    console.log(
      `🔧 Auto-tuning concluído. ${promoted ? "✅ candidato promovido" : "⏸️  baseline mantido"} (${reason})\n` +
        `   baseline:  winRate=${(baseline.winRate * 100).toFixed(1)}% profitFactor=${baseline.profitFactor.toFixed(2)} expectancy=${(baseline.expectancy * 100).toFixed(3)}% drawdown=${(baseline.maxDrawdown * 100).toFixed(2)}% sharpe=${baseline.sharpe.toFixed(2)} (${baseline.totalTrades} trades)\n` +
        `   candidato: winRate=${(candidate.winRate * 100).toFixed(1)}% profitFactor=${candidate.profitFactor.toFixed(2)} expectancy=${(candidate.expectancy * 100).toFixed(3)}% drawdown=${(candidate.maxDrawdown * 100).toFixed(2)}% sharpe=${candidate.sharpe.toFixed(2)} (${candidate.totalTrades} trades)`
    );
    logger.log({ event: "backtest_completed", lastRun: result.lastRun, params: result.current });
  } catch (err) {
    console.error("⚠️  Backtest falhou:", err.message);
    logger.log({ event: "backtest_error", message: err.message });
  }
}

async function boot() {
  const envLabel = config.bybit.demo ? "DEMO TRADING (dinheiro fictício)" : config.bybit.testnet ? "TESTNET" : "⚠️  MAINNET (dinheiro real)";
  console.log(`🤖 Bot iniciando — ${envLabel} | símbolo ${config.symbol}`);

  botState = state.load();
  botState = state.resetDailyLossIfNewDay(botState);

  instrumentInfo = await bybit.getInstrumentInfo(config.symbol);
  console.log(`ℹ️  Regras do símbolo: qtyStep=${instrumentInfo.qtyStep} tickSize=${instrumentInfo.tickSize} minOrderQty=${instrumentInfo.minOrderQty}`);

  try {
    await bybit.setLeverage(config.symbol, config.leverageMax);
  } catch (err) {
    // 110043 = "leverage not modified" — não é erro real, só significa que já estava configurada
    if (!/110043/.test(err.message)) {
      console.error("⚠️  Falha ao configurar alavancagem:", err.message);
    }
  }

  try {
    const { state: reconciled } = await state.reconcile(botState);
    botState = reconciled;
  } catch (err) {
    console.error("⚠️  Falha ao reconciliar estado com a Bybit no boot:", err.message);
  }

  await maybeRunBacktest();
  setInterval(maybeRunBacktest, config.backtestIntervalHours * 60 * 60 * 1000);

  await runHealthChecks();
  setInterval(runHealthChecks, config.healthCheckIntervalMs);

  loop();
}

async function loop() {
  const ok = await cycle();
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
  if (consecutiveFailures === 1) {
    console.warn("⚠️  Ciclo falhou — ativando backoff progressivo até o próximo sucesso.");
  }
  const delay = backoff.nextLoopDelay(consecutiveFailures, config.loopIntervalMs, config.loopMaxDelayMs);
  setTimeout(loop, delay);
}

boot();

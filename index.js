const config = require("./config");
const bybit = require("./lib/bybit");
const state = require("./lib/state");
const signal = require("./lib/signal");
const risk = require("./lib/risk");
const tradeLifecycle = require("./lib/tradeLifecycle");
const volatilityRegime = require("./lib/volatilityRegime");
const logger = require("./lib/logger");
const backtest = require("./lib/backtest");
const backoff = require("./lib/backoff");
const { createHealthRegistry } = require("./lib/health");
const healthChecks = require("./lib/healthChecks");
const alerts = require("./lib/alerts");
const connectivityStatus = require("./lib/connectivityStatus");

let botState;
let instrumentInfo;
let consecutiveFailures = 0;
let networkPauseLogged = false;

const healthRegistry = createHealthRegistry();
healthRegistry.registerCheck("bybit", healthChecks.checkBybit);
healthRegistry.registerCheck("bybit_collector", healthChecks.checkCollector);
healthRegistry.registerCheck("fear_greed_collector", healthChecks.checkFearGreed);
healthRegistry.registerCheck("btc_dominance_collector", healthChecks.checkBtcDominance);
healthRegistry.registerCheck("knowledge_collector", healthChecks.checkKnowledgeCollector);
healthRegistry.registerCheck("metrics_sampler", healthChecks.checkMetricsSampler);
healthRegistry.registerCheck("supervisor", healthChecks.checkSupervisor);
healthRegistry.registerCheck("connectivity", healthChecks.checkConnectivity);
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
    // Classificado ANTES de limpar o estado -- lib/tradeLifecycle.js::classifyExternalClose
    // precisa de stopLossPrice/takeProfitPrice/breakEvenApplied/trailingActivated
    // como estavam no momento do fechamento, não depois de zerados.
    const exitReason = tradeLifecycle.classifyExternalClose(botState, parseFloat(last.avgExitPrice));
    risk.registerTradeResult(botState, pnlPct);
    botState.openedAt = null;
    botState.stopLossPrice = null;
    botState.takeProfitPrice = null;
    botState.breakEvenApplied = false;
    botState.trailingActivated = false;
    botState.trailingDistance = null;
    botState.tpLevels = [];
    botState.tpLevelsFilled = 0;
    state.save(botState);
    logger.log({
      event: "position_closed_externally",
      reason: exitReason,
      pnlUsd,
      pnlPct,
      avgEntryPrice: last.avgEntryPrice,
      avgExitPrice: last.avgExitPrice,
      side: last.side,
      holdMs,
    });
    console.log(`ℹ️  Posição fechada (${exitReason}). PnL: $${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
  } catch (err) {
    console.error("⚠️  Não foi possível buscar closed-pnl:", err.message);
  }
}

// Fase D5 (TP Escalonado) -- posição segue aberta, mas encolheu porque um
// nível parcial (TP1/TP2) disparou no servidor. Diferente de
// handleExternalClose: não zera isOpened/side/entryPrice (a posição
// continua), só registra o resultado da fatia fechada e avança
// tpLevelsFilled. reducedQty vem de lib/state.js::reconcile.
async function handlePartialClose(reducedQty, equity) {
  try {
    const closedList = await bybit.getClosedPnl(config.symbol, 3);
    // A fatia parcial mais recente é a que tem closedSize mais próxima do
    // qty reduzido -- getClosedPnl vem mais recente primeiro, mas não custa
    // confirmar em vez de assumir que é sempre o índice 0.
    const match = closedList.find((c) => Math.abs(parseFloat(c.closedSize) - reducedQty) < 1e-6) || closedList[0];
    if (!match) {
      console.warn("⚠️  TP parcial detectado mas nenhum closed-pnl correspondente encontrado.");
      return;
    }

    const exitReason = tradeLifecycle.classifyPartialClose(botState);
    const pnlUsd = parseFloat(match.closedPnl);
    const pnlPct = equity > 0 ? pnlUsd / equity : 0;
    risk.registerTradeResult(botState, pnlPct);
    botState.tpLevelsFilled = (botState.tpLevelsFilled || 0) + 1;
    state.save(botState);

    logger.log({
      event: "partial_close",
      reason: exitReason,
      qty: reducedQty,
      pnlUsd,
      pnlPct,
      avgEntryPrice: match.avgEntryPrice,
      avgExitPrice: match.avgExitPrice,
      side: match.side,
    });
    console.log(`🎯 TP parcial (${exitReason}) -- qty ${reducedQty}, PnL: $${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
  } catch (err) {
    console.error("⚠️  Não foi possível processar TP parcial:", err.message);
  }
}

async function openPosition(side, analysis, equity) {
  const plan = risk.planOrder({ side, price: analysis.price, atr: analysis.atr, equity, params: analysis.params, instrumentInfo });

  if (plan.qty <= 0) {
    console.log("⚠️  Quantidade calculada é zero, ordem não enviada.");
    return;
  }

  const bybitSide = side === "buy" ? "Buy" : "Sell";
  const tpLevelsDesc = plan.tpLevels.map((l) => `${(l.qtyPct * 100).toFixed(0)}%@${l.r}R`).join(" + ") || "nenhum";
  console.log(
    `${side === "buy" ? "🟢" : "🔴"} Sinal de ${side.toUpperCase()}. qty=${plan.qty} stop=${plan.stopLossPrice} TP escalonado=${tpLevelsDesc}`
  );

  // Fase D5 -- takeProfit fixo não é mais anexado à ordem de entrada: TP1/TP2
  // (registrados abaixo como pernas Partial) assumem o papel de realização de
  // lucro; o que sobrar corre no break even/trailing (D3/D4). stopLossPrice
  // continua vindo junto da ordem (rede de segurança desde o primeiro tick).
  let res;
  try {
    res = await bybit.placeOrder({
      side: bybitSide,
      qty: plan.qty,
      stopLoss: plan.stopLossPrice,
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
  botState.openedAt = Date.now(); // hold time (Trading Health) e time stop (lib/tradeLifecycle.js)
  botState.stopLossPrice = plan.stopLossPrice; // referência de R pro break even (Fase D3)
  botState.takeProfitPrice = plan.takeProfitPrice; // referência pro Exit Analytics classificar o fechamento
  botState.breakEvenApplied = false;
  botState.trailingActivated = false;
  botState.trailingDistance = null;
  botState.tpLevels = plan.tpLevels || [];
  botState.tpLevelsFilled = 0;
  state.save(botState);

  // Fase D5 (TP Escalonado) -- registra cada nível como uma ordem Partial
  // separada, uma vez, na abertura (confirmado contra a API real: TP1+TP2
  // coexistem com stopLoss/trailing na mesma posição sem conflito). Não
  // precisa de checagem por ciclo -- a Bybit executa no servidor.
  for (const level of botState.tpLevels) {
    if (level.qty <= 0) continue;
    try {
      await bybit.setTradingStop({ tpslMode: "Partial", takeProfit: level.price, tpSize: level.qty });
    } catch (err) {
      console.error(`⚠️  Falha ao registrar TP parcial (R=${level.r}):`, err.message);
    }
  }

  logger.log({
    event: "order_opened",
    side: bybitSide,
    qty: plan.qty,
    price: analysis.price,
    stopLossPrice: plan.stopLossPrice,
    takeProfitPrice: plan.takeProfitPrice,
    tpLevels: plan.tpLevels,
    reasons: analysis.reasons,
    orderResult: res,
  });
}

// Fase D3 (Break Even): move o stop-loss pra entrada (risco zero) sem fechar
// a posição. Falha não derruba o ciclo -- o stop original enviado no
// placeOrder continua valendo como rede de segurança (mesmo padrão de
// tolerância já usado em setLeverage no boot).
async function applyBreakEven(analysis) {
  try {
    const stopLoss = instrumentInfo ? risk.roundToTick(botState.entryPrice, instrumentInfo.tickSize) : botState.entryPrice;
    await bybit.setTradingStop({ stopLoss });
    botState.breakEvenApplied = true;
    state.save(botState);
    logger.log({ event: "break_even_applied", entryPrice: botState.entryPrice, price: analysis.price });
    console.log(`🟰 Break even aplicado -- stop movido para a entrada ($${botState.entryPrice}).`);
  } catch (err) {
    console.error("⚠️  Falha ao aplicar break even:", err.message);
  }
}

// Fase D4 (Trailing ATR adaptativo): só chamado depois que o break even já
// foi aplicado (pré-requisito, ver lib/tradeLifecycle.js::isTrailingActivationDue).
// distance/regime já vêm calculados do ciclo -- computados uma única vez na
// ativação, não recalculados depois (a Bybit ratcheia o resto sozinha no
// servidor). Falha não derruba o ciclo, mesmo padrão de tolerância do break even.
async function applyTrailingStop(distance, regime) {
  try {
    const activePrice = tradeLifecycle.computeTrailingActivePrice(botState, distance);
    const roundedDistance = instrumentInfo ? risk.roundToTick(distance, instrumentInfo.tickSize) : distance;
    const roundedActivePrice = instrumentInfo ? risk.roundToTick(activePrice, instrumentInfo.tickSize) : activePrice;
    await bybit.setTradingStop({ trailingStop: roundedDistance, activePrice: roundedActivePrice });
    botState.trailingActivated = true;
    botState.trailingDistance = roundedDistance;
    state.save(botState);
    logger.log({ event: "trailing_stop_activated", distance: roundedDistance, activePrice: roundedActivePrice, regime });
    console.log(`📈 Trailing stop ativado (regime ${regime}) -- distância ${roundedDistance}, activePrice ${roundedActivePrice}.`);
  } catch (err) {
    console.error("⚠️  Falha ao ativar trailing stop:", err.message);
  }
}

// reason: lib/tradeLifecycle.js::REASONS ("signal_reversal" | "time_stop", e
// futuros incrementos da Fase D) -- só diferencia o evento logado (exitReason
// pro futuro Exit Analytics/Validation Engine), a mecânica de fechamento é a
// mesma pra qualquer motivo decidido pelo bot (reduceOnly na Bybit).
async function closePosition(reason, equity) {
  const bybitSide = botState.side === "Buy" ? "Sell" : "Buy"; // ordem oposta à posição atual, reduceOnly
  console.log(`🔁 Fechando posição ${botState.side} (${reason}).`);
  const holdMs = botState.openedAt ? Date.now() - botState.openedAt : null; // capturado antes do reset abaixo limpar openedAt

  const res = await bybit.placeOrder({
    side: bybitSide,
    qty: botState.qty,
    reduceOnly: true,
  });

  logger.log({ event: "order_closed_manually", reason, side: bybitSide, qty: botState.qty, orderResult: res });

  botState.isOpened = false;
  botState.side = null;
  botState.qty = null;
  botState.entryPrice = null;
  botState.lastTradeTime = Date.now();
  botState.openedAt = null;
  botState.stopLossPrice = null;
  botState.takeProfitPrice = null;
  botState.breakEvenApplied = false;
  botState.trailingActivated = false;
  botState.trailingDistance = null;
  botState.tpLevels = [];
  botState.tpLevelsFilled = 0;
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
        reason,
        pnlUsd,
        pnlPct,
        avgEntryPrice: last.avgEntryPrice,
        avgExitPrice: last.avgExitPrice,
        side: last.side,
        holdMs,
      });
      console.log(`ℹ️  PnL da posição fechada (${reason}): $${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%)`);
    }
  } catch (err) {
    console.error("⚠️  Não foi possível buscar closed-pnl após fechamento manual:", err.message);
  }
}

async function cycle() {
  try {
    // Pausa controlada em vez de descobrir a queda via exceção a cada ciclo:
    // sem isso, cada tick de 10s martelaria withRetry (até 4 tentativas,
    // ~30s) contra uma Bybit já sabidamente fora do ar. Não é falha do
    // ciclo -- devolve true pra não acionar o backoff de erro nem imprimir
    // "ciclo falhou" por algo que é intencional.
    if (!connectivityStatus.isOnline() || !connectivityStatus.isProviderHealthy("bybit")) {
      if (!networkPauseLogged) {
        console.log("⏸️  Rede/Bybit offline — pausando operação até a conexão voltar (sem novas compras/vendas).");
        networkPauseLogged = true;
      }
      return true;
    }
    if (networkPauseLogged) {
      console.log("▶️  Conectividade restabelecida — retomando operação.");
      networkPauseLogged = false;
    }

    botState = state.resetDailyLossIfNewDay(botState);

    const { state: reconciled, closedExternally, partiallyClosedQty } = await state.reconcile(botState);
    botState = reconciled;

    const { totalEquity } = await bybit.getWalletBalance();

    if (closedExternally) {
      await handleExternalClose(totalEquity);
    } else if (partiallyClosedQty > 0) {
      await handlePartialClose(partiallyClosedQty, totalEquity);
    }

    const candles = await bybit.getKlines(config.symbol, config.interval, 500);
    if (!candles) {
      console.log("⚠️  Sem candles. Pulando ciclo.");
      return;
    }

    // Terceiro gatilho do circuit breaker (Fase D2) -- observado por ciclo,
    // não por trade fechado (diferente de loss streak/drawdown diário).
    const regime = volatilityRegime.classifyVolatility(candles);
    risk.registerVolatilityCheck(botState, regime);
    state.save(botState);

    const analysis = signal.analyze(candles);
    const time = new Date().toLocaleTimeString();

    console.log("====================================");
    console.log(`⏰ ${time} | Equity: $${totalEquity.toFixed(2)}`);
    console.log(`💰 Price: ${analysis.price}`);
    console.log(`📊 EMA${analysis.params.emaShort}: ${analysis.ema8.toFixed(4)} | EMA${analysis.params.emaLong}: ${analysis.ema56.toFixed(4)}`);
    console.log(`📈 RSI: ${analysis.rsi.toFixed(2)} | StochRSI: ${analysis.stoch.toFixed(2)}`);
    console.log(`🌪️ Regime de volatilidade: ${regime}`);
    console.log(`📦 Posição aberta? ${botState.isOpened} (${botState.side || "-"})`);
    console.log(`🧠 Sinal: ${analysis.signal} (${analysis.reasons.join(",")})`);

    // Trade Lifecycle Engine: única pergunta sobre saídas que o bot decide e
    // executa ativamente (time stop, reversão de sinal, e futuros incrementos
    // da Fase D) -- evita espalhar mais um `if` aqui a cada saída nova.
    const lifecycle = tradeLifecycle.evaluate({ botState, analysis, now: Date.now(), config });
    if (lifecycle.reason) {
      await closePosition(lifecycle.reason, totalEquity);
    } else if (tradeLifecycle.isBreakEvenDue(botState, analysis)) {
      await applyBreakEven(analysis);
    } else {
      const multiplier = config.trailingStopAtrMultiplier[regime.toLowerCase()] ?? config.trailingStopAtrMultiplier.normal;
      const trailingDistance = analysis.atr * multiplier;
      if (tradeLifecycle.isTrailingActivationDue(botState, analysis, trailingDistance)) {
        await applyTrailingStop(trailingDistance, regime);
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

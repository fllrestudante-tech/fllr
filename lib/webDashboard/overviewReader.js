// Página Overview -- compõe pedaços já existentes de Trading/Replay +
// Posições (data/state.json) + Risk (computeKellyFraction/computeVarCvar,
// já em lib/tradingHealth.js) + Timeline (consolida 4 fontes já logadas:
// trades.jsonl, system_incidents, alerts_history, events_log). Nenhuma
// métrica nova, só orquestração e ordenação cronológica.
const { DEFAULT_DB_PATH } = require("../infra/db");
const { withReadonlyDb } = require("../infra/withReadonlyDb");
const { computeKellyFraction, computeVarCvar } = require("../tradingHealth");
const { queryIncidents } = require("../systemIncidents");
const { queryAlertsHistory } = require("../alertsHistory");
const stateStore = require("../state");
const { loadClosedTrades, computeCapitalSummary } = require("./tradingReader");
const { readReplaySummary } = require("./replayReader");

function readRisk(trades, state, now = Date.now()) {
  const pnlPcts = trades.map((t) => t.pnlPct);
  return {
    kellyFraction: computeKellyFraction(pnlPcts),
    varCvar: computeVarCvar(pnlPcts),
    circuitBreaker: {
      active: Boolean(state.circuitBreakerUntil && now < state.circuitBreakerUntil),
      until: state.circuitBreakerUntil,
    },
  };
}

function readOpenPosition(state) {
  if (!state.isOpened) return { open: false };
  return {
    open: true,
    side: state.side,
    entryPrice: state.entryPrice,
    qty: state.qty,
    stopLossPrice: state.stopLossPrice,
    takeProfitPrice: state.takeProfitPrice,
    trailingActivated: state.trailingActivated,
    openedAt: state.openedAt,
  };
}

// events_log tem ticker.updated/candle.closed/runtime_metrics.* rodando a
// cada poucos segundos (dezenas de milhares de linhas) -- incluir isso na
// Timeline afogaria qualquer evento que importe de verdade num segundo. Só
// os eventos discretos/pouco frequentes entram (funding/OI/long-short mudam
// bem mais devagar; backfill/conectividade/crash são incidentes reais).
const TIMELINE_EVENT_NAMES = ["funding.updated", "oi.updated", "long_short_ratio.updated", "backfill.completed", "connectivity.lost", "connectivity.restored", "supervisor.child_crashed", "market_event.created"];

function queryRecentEvents(db, limit) {
  const placeholders = TIMELINE_EVENT_NAMES.map(() => "?").join(",");
  return db.prepare(`SELECT event_name, payload, occurred_at FROM events_log WHERE event_name IN (${placeholders}) ORDER BY occurred_at DESC LIMIT ?`).all(...TIMELINE_EVENT_NAMES, limit);
}

/**
 * Consolida 4 fontes já logadas numa lista única ordenada por tempo --
 * nenhuma inferência causal (isso é idea-causal-event-log, fora de escopo),
 * só "o que já aconteceu, na ordem que aconteceu".
 */
function readTimeline({ dbPath = DEFAULT_DB_PATH, tradesFilePath, limit = 30 } = {}) {
  const trades = loadClosedTrades(tradesFilePath)
    .slice(-limit)
    .map((t) => ({ type: "trade", time: t.time, summary: `${t.event} (${t.reason ?? "?"}) ${(t.pnlPct * 100).toFixed(2)}%` }));

  const dbEvents = withReadonlyDb(
    dbPath,
    (db) => {
      const incidents = queryIncidents(db, { limit }).map((i) => ({ type: "incident", time: i.started_at, summary: `${i.type} (${i.severity ?? "?"})${i.ended_at ? " -- resolvido" : " -- em aberto"}` }));
      const alerts = queryAlertsHistory(db, { limit }).map((a) => ({ type: "alert", time: a.occurred_at, summary: `[${a.severity}] ${a.source}: ${a.message}` }));
      const collector = queryRecentEvents(db, limit).map((e) => ({ type: "collector", time: e.occurred_at, summary: e.event_name }));
      return [...incidents, ...alerts, ...collector];
    },
    []
  );

  return [...trades, ...dbEvents]
    .filter((e) => e.time)
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, limit);
}

function readOverview({ dbPath = DEFAULT_DB_PATH, now = Date.now() } = {}) {
  const trades = loadClosedTrades();
  const state = stateStore.load();

  return {
    capital: computeCapitalSummary(trades),
    risk: readRisk(trades, state, now),
    replay: readReplaySummary(),
    position: readOpenPosition(state),
    timeline: readTimeline({ dbPath }),
  };
}

module.exports = { readOverview, readRisk, readOpenPosition, readTimeline };

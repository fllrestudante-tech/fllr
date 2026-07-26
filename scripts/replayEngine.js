// CLI do Replay Engine -- espelha scripts/backtest.js (batch sob demanda,
// não uma leitura ao vivo). Carrega o maior trecho contíguo do
// market.db, roda lib/replayEngine.js::runReplay uma vez sobre o
// histórico inteiro e grava 3 arquivos em data/replay/ (JSONL/JSON,
// mesmo padrão de trades.jsonl/alerts.jsonl/histórico do
// metricsSampler.js -- sem tabela nova, sem migração). Rodar de novo
// reprocessa tudo do zero (sobrescreve), não é incremental nesta v1.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");
const candleHistory = require("../lib/candleHistory");
const { runReplay, computeStats, computeTransitions } = require("../lib/replayEngine");
const { DEFAULT_DB_PATH } = require("../lib/infra/db");

const REPLAY_DIR = path.join(__dirname, "..", "data", "replay");

function main() {
  const db = new Database(DEFAULT_DB_PATH, { readonly: true, fileMustExist: true });
  let candlesResult;
  try {
    candlesResult = candleHistory.getBacktestCandles(db, {
      symbol: config.symbol,
      interval: config.interval,
      intervalMinutes: Number(config.interval) || 1,
      lookbackDays: config.replay.lookbackDays,
      minCandles: config.replay.windowCandles,
    });
  } finally {
    db.close();
  }

  if (!candlesResult) {
    console.error("❌ Trecho contínuo insuficiente no market.db pra rodar o replay (precisa de pelo menos " + config.replay.windowCandles + " candles).");
    process.exit(1);
  }

  const candles = candlesResult.candles;
  console.log(`Replay Engine: ${candles.length} candles contíguos disponíveis.`);

  const snapshots = runReplay(candles, {
    stepCandles: config.replay.stepCandles,
    windowCandles: config.replay.windowCandles,
    outcomeHorizonCandles: config.replay.outcomeHorizonCandles,
    outcomeThresholdPct: config.replay.outcomeThresholdPct,
    structureLookback: config.structure.lookback,
    equalTolerancePct: config.structure.equalTolerancePct,
    sweepReversalLookahead: config.structure.sweepReversalLookahead,
    exhaustionLookback: config.structure.exhaustionLookback,
    confirmAge: config.structure.confirmAge,
    mitigationThreshold: config.structure.mitigationThreshold,
  });

  console.log(`Replay Engine: ${snapshots.length} snapshots gerados.`);

  if (!fs.existsSync(REPLAY_DIR)) fs.mkdirSync(REPLAY_DIR, { recursive: true });

  fs.writeFileSync(path.join(REPLAY_DIR, "snapshots.jsonl"), snapshots.map((s) => JSON.stringify(s)).join("\n") + (snapshots.length > 0 ? "\n" : ""));

  const allEvents = snapshots.flatMap((s) => s.newEvents);
  fs.writeFileSync(path.join(REPLAY_DIR, "events.jsonl"), allEvents.map((e) => JSON.stringify(e)).join("\n") + (allEvents.length > 0 ? "\n" : ""));

  const outcomeCounts = snapshots.reduce((acc, s) => {
    acc[s.outcome] = (acc[s.outcome] || 0) + 1;
    return acc;
  }, {});

  // Combinações padrão de exemplo -- responde exatamente a pergunta central
  // do usuário ("Structure X + Liquidity Y + FVG Z acerta quanto?").
  // computeStats aceita qualquer subconjunto de Brains -- explorar outras
  // combinações fica pra quem for consultar snapshots.jsonl direto.
  const stats = {
    generatedAt: new Date().toISOString(),
    candleCount: candles.length,
    snapshotCount: snapshots.length,
    outcomeCounts,
    combos: {
      "structure+liquidity": computeStats(snapshots, ["structure", "liquidity"]),
      "structure+liquidity+fvg": computeStats(snapshots, ["structure", "liquidity", "fvg"]),
      "orderBlock+institutional": computeStats(snapshots, ["orderBlock", "institutional"]),
    },
    transitions: {
      context: computeTransitions(snapshots, "context"),
      structure: computeTransitions(snapshots, "structure"),
    },
  };
  fs.writeFileSync(path.join(REPLAY_DIR, "stats.json"), JSON.stringify(stats, null, 2));

  console.log(`Gravado em ${REPLAY_DIR}: snapshots.jsonl, events.jsonl, stats.json`);
  console.log("Vereditos:", JSON.stringify(outcomeCounts));
}

main();

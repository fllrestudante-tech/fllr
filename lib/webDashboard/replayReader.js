// Página Replay -- lê data/replay/stats.json (já escrito por
// scripts/replayEngine.js/npm run replay) e registry/research-objects.json,
// sem recalcular nada. `decisionBrainReadiness` já vem pronto dentro do
// stats.json (gerado por lib/brainAnalytics.js::evaluateDecisionBrainReadiness
// na última rodada de replay) -- o dashboard só repassa.
const fs = require("fs");
const path = require("path");
const config = require("../../config");
const { loadRegistry, listByType } = require("../registry/registryStore");

const DEFAULT_REPLAY_STATS_PATH = path.join(__dirname, "..", "..", "data", "replay", "stats.json");

function readReplayStats(filePath = DEFAULT_REPLAY_STATS_PATH) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readReplay({ statsPath = DEFAULT_REPLAY_STATS_PATH } = {}) {
  const stats = readReplayStats(statsPath);
  const objects = loadRegistry();
  const experiments = listByType(objects, "experiment");
  const target = config.replay.minSnapshotsForDecisionBrain;

  if (!stats) {
    return { available: false, reason: "data/replay/stats.json ainda não existe -- rode npm run replay primeiro", experimentsCount: experiments.length };
  }

  const snapshotCount = stats.snapshotCount ?? 0;
  return {
    available: true,
    generatedAt: stats.generatedAt,
    snapshotCount,
    snapshotTarget: target,
    // "dias restantes" foi omitido de propósito -- não existe série histórica
    // de snapshotCount persistida em lugar nenhum, e a regra do plano é
    // simplificar a interface em vez de fabricar uma taxa de crescimento
    // sem dado real por trás.
    snapshotProgressPct: target > 0 ? Math.round((snapshotCount / target) * 1000) / 10 : null,
    brainAccuracy: stats.brainAccuracy ?? null,
    marginalContribution: stats.marginalContribution ?? null,
    redundancy: stats.redundancy ?? null,
    decisionBrainReadiness: stats.decisionBrainReadiness ?? null,
    experimentsCount: experiments.length,
  };
}

/** Versão condensada pro card da Overview -- só o essencial. */
function readReplaySummary(opts) {
  const full = readReplay(opts);
  if (!full.available) return { available: false, reason: full.reason };
  return { available: true, snapshotCount: full.snapshotCount, snapshotTarget: full.snapshotTarget, snapshotProgressPct: full.snapshotProgressPct, decisionBrainReady: full.decisionBrainReadiness?.ready ?? false };
}

module.exports = { readReplay, readReplaySummary, readReplayStats, DEFAULT_REPLAY_STATS_PATH };

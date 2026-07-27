// CLI batch do Experiments Engine -- primeiro consumidor real do Feature
// Registry. Não recalcula nada: lê snapshots já gerados por `npm run
// replay` (data/replay/snapshots.jsonl) e despacha pras funções puras já
// existentes via lib/experiments/experimentRunner.js. Rodar de novo
// atualiza `metrics.replay` de cada experimento mas preserva status/tags
// curados à mão (ver toResearchObjectFields).
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { runExperiment, toResearchObjectFields } = require("../lib/experiments/experimentRunner");
const { loadRegistry, saveRegistry, findById, upsertResearchObject } = require("../lib/registry/registryStore");

const SNAPSHOTS_PATH = path.join(__dirname, "..", "data", "replay", "snapshots.jsonl");
const DEFINITIONS_PATH = path.join(__dirname, "..", "experiments", "definitions.json");
const RUNS_DIR = path.join(__dirname, "..", "data", "experiments");
const RUNS_PATH = path.join(RUNS_DIR, "runs.jsonl");

function loadSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_PATH)) {
    console.error(`❌ ${SNAPSHOTS_PATH} não existe -- rode "npm run replay" primeiro.`);
    process.exit(1);
  }
  const raw = fs.readFileSync(SNAPSHOTS_PATH, "utf8").trim();
  return raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
}

function loadDefinitions() {
  if (!fs.existsSync(DEFINITIONS_PATH)) {
    console.error(`❌ ${DEFINITIONS_PATH} não existe.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(DEFINITIONS_PATH, "utf8"));
}

function appendRun(entry) {
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.appendFileSync(RUNS_PATH, JSON.stringify(entry) + "\n");
}

function main() {
  const snapshots = loadSnapshots();
  const definitions = loadDefinitions();
  console.log(`Experiments Engine: ${snapshots.length} snapshots carregados, ${definitions.length} definições.`);

  let objects = loadRegistry();
  const rows = [];

  for (const definition of definitions) {
    let runResult;
    try {
      runResult = runExperiment(definition, snapshots, { outcomeThresholdPct: config.replay.outcomeThresholdPct });
    } catch (err) {
      console.error(`❌ ${definition.id}: ${err.message}`);
      continue;
    }

    appendRun({ id: definition.id, runAt: new Date().toISOString(), ...runResult });

    const existing = findById(objects, definition.id);
    const fields = toResearchObjectFields(definition, runResult, { existing });
    objects = upsertResearchObject(objects, fields, { note: "npm run experiments" });

    const saved = findById(objects, definition.id);
    rows.push({
      id: saved.id,
      kind: definition.kind,
      status: saved.status,
      metrics: JSON.stringify(saved.metrics.replay),
    });
  }

  saveRegistry(objects);

  console.log("\n" + "id".padEnd(42) + "kind".padEnd(22) + "status".padEnd(12) + "metrics.replay");
  for (const row of rows) {
    console.log(row.id.padEnd(42) + row.kind.padEnd(22) + row.status.padEnd(12) + row.metrics);
  }
  console.log(`\n✅ ${rows.length}/${definitions.length} experimentos gravados no Registry (${RUNS_PATH}).`);
}

main();

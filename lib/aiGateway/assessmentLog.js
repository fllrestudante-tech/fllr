// Trilha de auditoria do AI Gateway -- uma linha JSONL por chamada a
// getAssessment (sucesso OU falha). requestId/contextHash servem de chave de
// correlação pra, no futuro, cruzar com trades reais e medir empiricamente
// se o enriquecimento por IA ajudou (não é um logger genérico -- ver
// lib/logger.js pra trade/alert log, que tem semântica diferente).
const fs = require("fs");
const path = require("path");
const config = require("../../config");

const SCHEMA_VERSION = 1;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logAssessment(record, filePath = config.paths.aiAssessmentsLog) {
  ensureDir(filePath);
  const line = JSON.stringify({ schemaVersion: SCHEMA_VERSION, time: new Date().toISOString(), ...record });
  fs.appendFileSync(filePath, line + "\n");
}

module.exports = { logAssessment, SCHEMA_VERSION };

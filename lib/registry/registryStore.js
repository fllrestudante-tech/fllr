// I/O fino sobre o Feature Registry -- lê/grava registry/research-objects.json
// (curado à mão, versionado em git, ao contrário de data/*.json que é
// runtime/gitignored). `fsImpl` é sempre injetável, mesmo padrão de
// lib/atomicWrite.js/lib/collectors -- permite testar sem tocar disco real.
const fs = require("fs");
const path = require("path");
const { atomicWriteJsonSync } = require("../atomicWrite");
const { createResearchObject, validateResearchObject } = require("./researchObject");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "registry", "research-objects.json");

function loadRegistry({ filePath = DEFAULT_PATH, fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(filePath)) return [];

  const raw = fsImpl.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Registry JSON inválido em ${filePath}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Registry em ${filePath} deve conter um array de Research Objects`);
  }
  return parsed;
}

function saveRegistry(objects, { filePath = DEFAULT_PATH, fsImpl = fs } = {}) {
  const sorted = [...objects].sort((a, b) => a.id.localeCompare(b.id));
  atomicWriteJsonSync(filePath, sorted, { fsImpl });
}

function findById(objects, id) {
  return objects.find((obj) => obj.id === id) || null;
}

function listByType(objects, type) {
  return objects.filter((obj) => obj.type === type);
}

function listByStatus(objects, status) {
  return objects.filter((obj) => obj.status === status);
}

// `status` é vocabulário aberto (ver researchObject.js) -- agrega o que
// existir de fato no registro, em vez de assumir um conjunto fixo de
// estados que já ficaria desatualizado (hoje: production/idea/research/
// validated/backlog/rejected).
function countByStatus(objects) {
  const byStatus = {};
  for (const obj of objects) {
    byStatus[obj.status] = (byStatus[obj.status] || 0) + 1;
  }
  return { total: objects.length, byStatus };
}

// Resposta ao pedido de "usedBy"/"brainConsumers" sem armazenar/duplicar a
// aresta -- computa quem depende de `id`, direto ou transitivamente, a
// partir de dependsOn (única fonte de verdade). Mesmo princípio já usado
// no projeto pra market_phase (calculado sob consulta, não persistido).
function listConsumers(objects, id, { transitive = true } = {}) {
  const direct = objects.filter((obj) => Array.isArray(obj.dependsOn) && obj.dependsOn.includes(id));
  if (!transitive) return direct;

  const found = new Map(direct.map((obj) => [obj.id, obj]));
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift();
    const next = objects.filter(
      (obj) => Array.isArray(obj.dependsOn) && obj.dependsOn.includes(current.id) && !found.has(obj.id)
    );
    for (const obj of next) {
      found.set(obj.id, obj);
      queue.push(obj);
    }
  }
  return Array.from(found.values());
}

// Agrega listConsumers por status -- responde "Feature X -> N experiments,
// quantos validated/rejected/research" sem nenhuma tabela/campo novo, só um
// groupBy sobre o que listConsumers já devolve.
function groupConsumersByStatus(objects, id, { type, transitive = true } = {}) {
  let consumers = listConsumers(objects, id, { transitive });
  if (type) consumers = consumers.filter((obj) => obj.type === type);

  const byStatus = {};
  for (const obj of consumers) {
    byStatus[obj.status] = (byStatus[obj.status] || 0) + 1;
  }
  return { total: consumers.length, byStatus };
}

function validateRegistryIntegrity(objects) {
  const errors = [];
  const seenIds = new Set();
  for (const obj of objects) {
    if (!obj || !obj.id) continue;
    if (seenIds.has(obj.id)) {
      errors.push(`id duplicado: "${obj.id}"`);
    } else {
      seenIds.add(obj.id);
    }
  }

  for (const obj of objects) {
    for (const dep of obj.dependsOn || []) {
      if (!seenIds.has(dep)) {
        errors.push(`${obj.id}: dependsOn aponta para id inexistente "${dep}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function historyEntry(timestamp, action, note) {
  const entry = { date: timestamp, action };
  if (note) entry.note = note;
  return entry;
}

// Puro: devolve um array novo, nunca muta `objects`. Se `fields.id` já
// existir, SUBSTITUI o objeto inteiro (preservando só createdAt/history),
// gerando entradas automáticas de history quando status/maturity mudarem --
// não é campo solto que alguém precisa lembrar de preencher à mão.
function upsertResearchObject(objects, fields, { now = () => new Date().toISOString(), note } = {}) {
  const timestamp = now();
  const existing = findById(objects, fields.id);

  const candidate = createResearchObject(fields, { now: () => timestamp });
  if (existing) {
    candidate.createdAt = existing.createdAt;
    candidate.history = Array.isArray(existing.history) ? [...existing.history] : [];
  } else {
    candidate.history = [historyEntry(timestamp, "created", note)];
  }

  const { valid, errors } = validateResearchObject(candidate);
  if (!valid) {
    throw new Error(`Research Object inválido:\n- ${errors.join("\n- ")}`);
  }

  if (existing) {
    if (existing.status !== candidate.status) {
      candidate.history.push(historyEntry(timestamp, `status: ${existing.status} → ${candidate.status}`, note));
    }
    if (existing.maturity !== candidate.maturity) {
      candidate.history.push(historyEntry(timestamp, `maturity: ${existing.maturity} → ${candidate.maturity}`, note));
    }
  }

  return [...objects.filter((obj) => obj.id !== candidate.id), candidate];
}

module.exports = {
  DEFAULT_PATH,
  loadRegistry,
  saveRegistry,
  findById,
  listByType,
  listByStatus,
  countByStatus,
  listConsumers,
  groupConsumersByStatus,
  validateRegistryIntegrity,
  upsertResearchObject,
};

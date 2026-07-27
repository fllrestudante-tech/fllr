// Forma comum a todo Research Object do catálogo (Feature Registry v1) --
// mesmo espírito de lib/brains/brainResult.js: uma única forma pra
// Feature/Indicator/Brain/Synthesis/Engine e, no futuro, Experiment/Paper/
// Benchmark/Dataset/Model, evitando reinventar o formato a cada tipo novo.
//
// `type`/`status`/`owner.type` são vocabulário ABERTO (string livre, só
// validada como não-vazia) -- um enum fechado quebraria assim que um tipo
// novo (Paper, Benchmark...) fosse cunhado sem exigir alteração de código
// aqui. `maturity` é a única escala FECHADA (0-5), por ser um número
// ordinal exato definido pelo usuário, distinto de `status`: `status` é o
// estado curatorial ("isto é pra produção"), `maturity` é a profundidade
// de evidência que sustenta isso (0 Idea, 1 Prototype, 2 Replay,
// 3 Statistical, 4 Production, 5 Institutional -- mesma escala de
// lib/researchMaturity.js, hoje aplicada só a Brains).
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Campos nomeados dentro de cada fase de `metrics` (replay/paperTrading/
// live) -- validados como número quando presentes, mas a lista de fases e
// de chaves extras continua aberta (Experiments futuros vão precisar de
// métricas que não dá pra prever hoje).
const METRIC_FIELDS = ["accuracy", "precision", "recall", "snapshots", "winrate", "avgRR", "profitFactor"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createResearchObject(fields = {}, { now = () => new Date().toISOString() } = {}) {
  const timestamp = now();
  return {
    id: fields.id,
    type: fields.type,
    name: fields.name,
    description: fields.description || "",
    owner: fields.owner || { type: "internal", name: "internal" },
    references: fields.references || [],
    status: fields.status,
    maturity: fields.maturity != null ? fields.maturity : 0,
    tags: fields.tags || [],
    dependsOn: fields.dependsOn || [],
    metrics: fields.metrics || {},
    history: fields.history || [],
    createdAt: fields.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function validateResearchObject(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { valid: false, errors: ["objeto inválido"] };
  }

  if (!isNonEmptyString(obj.id)) {
    errors.push("id é obrigatório e deve ser string não vazia");
  } else if (!ID_PATTERN.test(obj.id)) {
    errors.push(`id "${obj.id}" deve ser kebab-case (ex: feature-bos)`);
  }

  if (!isNonEmptyString(obj.type)) errors.push("type é obrigatório e deve ser string não vazia");
  if (!isNonEmptyString(obj.name)) errors.push("name é obrigatório e deve ser string não vazia");
  if (!isNonEmptyString(obj.status)) errors.push("status é obrigatório e deve ser string não vazia");

  if (!Number.isInteger(obj.maturity) || obj.maturity < 0 || obj.maturity > 5) {
    errors.push("maturity deve ser inteiro entre 0 e 5");
  }

  if (!isPlainObject(obj.owner)) {
    errors.push("owner deve ser objeto {type, name}");
  } else {
    if (!isNonEmptyString(obj.owner.type)) errors.push("owner.type é obrigatório e deve ser string não vazia");
    if (!isNonEmptyString(obj.owner.name)) errors.push("owner.name é obrigatório e deve ser string não vazia");
  }

  if (!Array.isArray(obj.references)) {
    errors.push("references deve ser array");
  } else {
    obj.references.forEach((ref, i) => {
      if (!isPlainObject(ref) || !isNonEmptyString(ref.type)) {
        errors.push(`references[${i}] deve ser objeto com type string não vazia`);
      }
    });
  }

  if (!isStringArray(obj.tags)) errors.push("tags deve ser array de strings");
  if (!isStringArray(obj.dependsOn)) errors.push("dependsOn deve ser array de strings");

  if (!isPlainObject(obj.metrics)) {
    errors.push("metrics deve ser objeto");
  } else {
    for (const [phase, phaseMetrics] of Object.entries(obj.metrics)) {
      if (!isPlainObject(phaseMetrics)) {
        errors.push(`metrics.${phase} deve ser objeto`);
        continue;
      }
      for (const field of METRIC_FIELDS) {
        if (field in phaseMetrics && !Number.isFinite(phaseMetrics[field])) {
          errors.push(`metrics.${phase}.${field} deve ser número finito`);
        }
      }
    }
  }

  if (!Array.isArray(obj.history)) {
    errors.push("history deve ser array");
  } else {
    obj.history.forEach((entry, i) => {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.date) || !isNonEmptyString(entry.action)) {
        errors.push(`history[${i}] deve ser objeto com date e action string não vazias`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { createResearchObject, validateResearchObject, ID_PATTERN, METRIC_FIELDS };

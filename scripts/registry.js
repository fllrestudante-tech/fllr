// CLI fina sobre o Feature Registry -- só chama lib/registry/*, nenhuma
// lógica nova aqui além de parsing de argv e formatação de saída.
// Uso: npm run registry -- <list|show|validate|add> [flags]
const {
  DEFAULT_PATH,
  loadRegistry,
  saveRegistry,
  findById,
  listByType,
  listByStatus,
  listConsumers,
  groupConsumersByStatus,
  validateRegistryIntegrity,
  upsertResearchObject,
} = require("../lib/registry/registryStore");
const { validateResearchObject } = require("../lib/registry/researchObject");

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      positional.push(arg);
      continue;
    }
    const [, key, value] = match;
    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  }
  return { flags, positional };
}

function splitCsv(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

// "type:url:note" (repetível via --reference=...) -- só type é obrigatório.
function parseReferences(value) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries.map((entry) => {
    const [type, url, note] = entry.split(":");
    const ref = { type };
    if (url) ref.url = url;
    if (note) ref.note = note;
    return ref;
  });
}

function printTable(rows, columns) {
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col] ?? "").length)));
  const printRow = (values) => console.log(values.map((v, i) => String(v).padEnd(widths[i])).join("  "));
  printRow(columns);
  printRow(widths.map((w) => "-".repeat(w)));
  for (const row of rows) printRow(columns.map((col) => row[col] ?? ""));
}

function cmdList(flags) {
  let objects = loadRegistry();
  if (flags.type) objects = listByType(objects, flags.type);
  if (flags.status) objects = listByStatus(objects, flags.status);
  if (objects.length === 0) {
    console.log("(registry vazio ou filtro sem resultados)");
    return;
  }
  printTable(objects, ["id", "type", "status", "maturity", "name"]);
}

function cmdShow(id) {
  if (!id) {
    console.error("uso: npm run registry -- show <id>");
    process.exit(1);
  }
  const objects = loadRegistry();
  const found = findById(objects, id);
  if (!found) {
    console.error(`id não encontrado: ${id}`);
    process.exit(1);
  }

  console.log(JSON.stringify(found, null, 2));

  const brokenDeps = (found.dependsOn || []).filter((dep) => !findById(objects, dep));
  if (brokenDeps.length > 0) {
    console.log(`\n⚠️  dependsOn quebrado: ${brokenDeps.join(", ")}`);
  }

  const direct = listConsumers(objects, id, { transitive: false }).map((o) => o.id);
  const transitive = listConsumers(objects, id, { transitive: true })
    .map((o) => o.id)
    .filter((consumerId) => !direct.includes(consumerId));
  console.log(`\nUsado por (direto): ${direct.length ? direct.join(", ") : "(nenhum)"}`);
  console.log(`Usado por (transitivo): ${transitive.length ? transitive.join(", ") : "(nenhum)"}`);

  const experiments = groupConsumersByStatus(objects, id, { type: "experiment" });
  if (experiments.total > 0) {
    const parts = Object.entries(experiments.byStatus).map(([status, count]) => `${status}: ${count}`);
    console.log(`\nExperiments: ${experiments.total} total (${parts.join(", ")})`);
  }
}

function cmdValidate() {
  const objects = loadRegistry();
  let hasErrors = false;

  for (const obj of objects) {
    const { valid, errors } = validateResearchObject(obj);
    if (!valid) {
      hasErrors = true;
      console.error(`❌ ${obj.id || "(sem id)"}:\n  - ${errors.join("\n  - ")}`);
    }
  }

  const integrity = validateRegistryIntegrity(objects);
  if (!integrity.valid) {
    hasErrors = true;
    console.error(`❌ Integridade do registro:\n  - ${integrity.errors.join("\n  - ")}`);
  }

  if (hasErrors) {
    process.exit(1);
  }
  console.log(`✅ ${objects.length} Research Objects válidos, sem referências quebradas.`);
}

function cmdAdd(flags) {
  if (!flags.id) {
    console.error("--id é obrigatório");
    process.exit(1);
  }

  const objects = loadRegistry();
  const existing = findById(objects, flags.id) || {};

  const owner =
    flags["owner-type"] || flags["owner-name"]
      ? {
          type: flags["owner-type"] || existing.owner?.type || "internal",
          name: flags["owner-name"] || existing.owner?.name || "internal",
        }
      : existing.owner;

  const fields = {
    ...existing,
    id: flags.id,
    type: flags.type || existing.type,
    name: flags.name || existing.name,
    status: flags.status || existing.status,
    description: flags.description !== undefined ? flags.description : existing.description,
    maturity: flags.maturity !== undefined ? Number(flags.maturity) : existing.maturity,
    tags: flags.tags !== undefined ? splitCsv(flags.tags) : existing.tags,
    dependsOn: flags.depends !== undefined ? splitCsv(flags.depends) : existing.dependsOn,
    owner,
    references: flags.reference !== undefined ? parseReferences(flags.reference) : existing.references,
  };

  let next;
  try {
    next = upsertResearchObject(objects, fields, { note: flags.note });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  saveRegistry(next);
  console.log(`✅ ${fields.id} salvo em ${DEFAULT_PATH}`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  switch (command) {
    case "list":
      return cmdList(flags);
    case "show":
      return cmdShow(positional[0]);
    case "validate":
      return cmdValidate();
    case "add":
      return cmdAdd(flags);
    default:
      console.log("uso: npm run registry -- <list|show|validate|add> [flags]");
      process.exit(command ? 1 : 0);
  }
}

main();

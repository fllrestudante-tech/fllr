// Gera research/adoption-matrix.md a partir do Feature Registry -- nunca
// editar o .md à mão, ele fica desatualizado na primeira mudança no
// Registry. Só leitura do registry (lib/registry/registryStore.js),
// nenhuma lógica nova de negócio aqui.
const fs = require("fs");
const path = require("path");
const { loadRegistry, findById } = require("../lib/registry/registryStore");

const OUT_PATH = path.join(__dirname, "..", "research", "adoption-matrix.md");
const PRIORITY_ORDER = ["high", "medium", "low"];
const PRIORITY_LABEL = { high: "Alta", medium: "Média", low: "Baixa" };

function priorityOf(obj) {
  const tag = obj.tags.find((t) => t.startsWith("priority:"));
  return tag ? tag.split(":")[1] : null;
}

function originsOf(obj) {
  const origins = obj.tags.filter((t) => t.startsWith("validated-by:")).map((t) => t.split(":")[1]);
  if (obj.owner && obj.owner.type === "external" && !origins.includes(obj.owner.name.toLowerCase())) {
    origins.unshift(obj.owner.name);
  }
  return [...new Set(origins)];
}

function row(obj) {
  const origins = originsOf(obj).join(", ") || "--";
  const deps = obj.dependsOn.length ? obj.dependsOn.map((d) => `\`${d}\``).join(", ") : "--";
  return `| \`${obj.id}\` | ${obj.name} | ${origins} | ${obj.status} | ${deps} |`;
}

function main() {
  const objects = loadRegistry();
  const ideas = objects.filter((o) => o.type === "idea");
  const externalIdeas = ideas.filter((o) => o.owner && o.owner.type === "external");
  const rejected = ideas.filter((o) => o.status === "rejected");
  const activeExternal = externalIdeas.filter((o) => o.status !== "rejected");

  const lines = [];
  lines.push("# Adoption Matrix");
  lines.push("");
  lines.push(`_Gerado automaticamente por \`npm run adoption-matrix\` em ${new Date().toISOString()} a partir de \`registry/research-objects.json\` (${objects.length} Research Objects). Não editar este arquivo à mão._`);
  lines.push("");
  lines.push("Ideias extraídas das auditorias de concorrentes (OpenAlice/Freqtrade/Hummingbot/Lean/Jesse), agrupadas por prioridade. Ver `research/competitor-intelligence/` para o contexto completo de cada origem, e `npm run registry -- show <id>` para o Research Object inteiro (referências, dependências, histórico).");
  lines.push("");

  const capabilities = objects.filter((o) => o.type === "capability").sort((a, b) => a.id.localeCompare(b.id));
  if (capabilities.length > 0) {
    lines.push("## Mapa de Capacidades");
    lines.push("");
    lines.push("O que o sistema sabe fazer, não só quais componentes existem. Cada capability é um `type: \"capability\"` no Registry -- `dependsOn` lista quem implementa.");
    lines.push("");
    lines.push("| capability | status | implementado por |");
    lines.push("|---|---|---|");
    for (const cap of capabilities) {
      const implementers = cap.dependsOn
        .map((id) => {
          const impl = findById(objects, id);
          return impl ? `\`${id}\` (${impl.status})` : `\`${id}\` (?)`;
        })
        .join(", ");
      lines.push(`| **${cap.name}** | ${cap.status} | ${implementers || "--"} |`);
    }
    lines.push("");
  }

  lines.push("## Ideias extraídas de auditorias de concorrentes");
  lines.push("");
  for (const priority of PRIORITY_ORDER) {
    const group = activeExternal.filter((o) => priorityOf(o) === priority);
    if (group.length === 0) continue;
    lines.push(`### Prioridade ${PRIORITY_LABEL[priority]}`);
    lines.push("");
    lines.push("| id | nome | origem | status | depende de |");
    lines.push("|---|---|---|---|---|");
    for (const obj of group.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(row(obj));
    }
    lines.push("");
  }

  const fase4 = ideas.filter((o) => o.tags.includes("fase-4")).sort((a, b) => a.id.localeCompare(b.id));
  if (fase4.length > 0) {
    lines.push("## Blueprint de pesquisa contínua (Fase 4 -- síntese própria, não de auditoria)");
    lines.push("");
    lines.push("| id | nome | status | prioridade | depende de |");
    lines.push("|---|---|---|---|---|");
    for (const obj of fase4) {
      const deps = obj.dependsOn.length ? obj.dependsOn.map((d) => `\`${d}\``).join(", ") : "--";
      lines.push(`| \`${obj.id}\` | ${obj.name} | ${obj.status} | ${priorityOf(obj) ? PRIORITY_LABEL[priorityOf(obj)] : "--"} | ${deps} |`);
    }
    lines.push("");
  }

  const noPriority = activeExternal.filter((o) => !priorityOf(o));
  if (noPriority.length > 0) {
    lines.push("## Sem prioridade marcada");
    lines.push("");
    lines.push("| id | nome | origem | status | depende de |");
    lines.push("|---|---|---|---|---|");
    for (const obj of noPriority.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(row(obj));
    }
    lines.push("");
  }

  if (rejected.length > 0) {
    lines.push("## Descartado");
    lines.push("");
    lines.push("| id | nome | origem | motivo |");
    lines.push("|---|---|---|---|");
    for (const obj of rejected.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`| \`${obj.id}\` | ${obj.name} | ${originsOf(obj).join(", ")} | ${obj.description} |`);
    }
    lines.push("");
  }

  lines.push("## Componentes validados por auditoria externa");
  lines.push("");
  lines.push("Componentes do próprio cripto10 que alguma auditoria confirmou como iguais/melhores que o equivalente externo (`validated-by:*` nas tags).");
  lines.push("");
  lines.push("| id | nome | validado por |");
  lines.push("|---|---|---|");
  const validated = objects
    .filter((o) => o.type !== "idea" && o.tags.some((t) => t.startsWith("validated-by:")))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const obj of validated) {
    const by = obj.tags.filter((t) => t.startsWith("validated-by:")).map((t) => t.split(":")[1]).join(", ");
    lines.push(`| \`${obj.id}\` | ${obj.name} | ${by} |`);
  }
  lines.push("");

  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.log(`Gravado: ${OUT_PATH} (${activeExternal.length} ideias ativas, ${rejected.length} descartadas, ${validated.length} componentes validados)`);
}

main();

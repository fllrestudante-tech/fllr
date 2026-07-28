// Gera research/capability-map.md a partir do Feature Registry -- nunca
// editar o .md à mão, mesma disciplina de adoptionMatrix.js/dnaMatrix.js.
// Pergunta que ESTE documento responde, diferente das outras duas: não
// "de onde veio" (Adoption Matrix) nem "combina com os princípios" (DNA
// Matrix), mas **"o que o sistema é capaz de fazer"** -- organizado em 6
// domínios com sub-domínios (`capmap-domain:*`/`capmap-subdomain:*`,
// taxonomia própria deste documento, separada da `domain:*` de 4
// domínios que a DNA Matrix usa -- documentos diferentes podem organizar
// o mesmo Registry de formas diferentes, sem forçar concordância).
const fs = require("fs");
const path = require("path");
const { loadRegistry, listConsumers } = require("../lib/registry/registryStore");

const OUT_PATH = path.join(__dirname, "..", "research", "capability-map.md");

const DOMAIN_ORDER = ["knowledge", "analysis", "discovery", "execution", "research", "infrastructure"];
const DOMAIN_LABEL = {
  knowledge: "1. Knowledge Domain",
  analysis: "2. Analysis Domain",
  discovery: "3. Discovery Domain",
  execution: "4. Execution Domain",
  research: "5. Research Domain",
  infrastructure: "6. Infrastructure Domain",
};

function tagValue(obj, prefix) {
  const tag = obj.tags.find((t) => t.startsWith(prefix + ":"));
  return tag ? tag.split(":").slice(1).join(":") : null;
}

/**
 * Capability Stage -- ciclo de vida independente do `status` cru do
 * Registry (que é vocabulário aberto e nem sempre alinhado 1:1 com o
 * ciclo de vida de uma capacidade). Precedência: deprecated/production/
 * validated são estados terminais checados primeiro; `maturity` decide
 * Replay vs. Prototype pra quem ainda não chegou lá; status
 * research/backlog é o fallback antes de cair em Idea.
 */
function stageOf(obj) {
  if (obj.status === "rejected" || obj.status === "deprecated") return { emoji: "🛠", label: "Deprecated" };
  if (obj.status === "production") return { emoji: "🚀", label: "Production" };
  if (obj.status === "validated") return { emoji: "✅", label: "Validated" };
  if (obj.maturity >= 2) return { emoji: "🔁", label: "Replay" };
  if (obj.maturity >= 1) return { emoji: "🧪", label: "Prototype" };
  if (obj.status === "research" || obj.status === "backlog") return { emoji: "📚", label: "Research" };
  return { emoji: "💡", label: "Idea" };
}

function replayValidated(obj) {
  return obj.metrics && obj.metrics.replay && Object.keys(obj.metrics.replay).length > 0 ? "✅" : "❌";
}

function inProduction(obj) {
  return obj.status === "production" ? "✅" : "❌";
}

function card(obj, objects) {
  const stage = stageOf(obj);
  const consumers = listConsumers(objects, obj.id, { transitive: false }).map((o) => o.id);
  const lines = [];
  lines.push(`#### ${stage.emoji} ${obj.name}`);
  lines.push("");
  lines.push("| Campo | Valor |");
  lines.push("|---|---|");
  lines.push(`| Research Object | \`${obj.id}\` |`);
  lines.push(`| Capability Stage | ${stage.emoji} ${stage.label} |`);
  lines.push(`| Status | ${obj.status} |`);
  lines.push(`| Maturity | ${obj.maturity} |`);
  lines.push(`| Depends On | ${obj.dependsOn.length ? obj.dependsOn.map((d) => `\`${d}\``).join(", ") : "--"} |`);
  lines.push(`| Consumer | ${consumers.length ? consumers.map((c) => `\`${c}\``).join(", ") : "--"} |`);
  lines.push(`| Replay Validated | ${replayValidated(obj)} |`);
  lines.push(`| Production | ${inProduction(obj)} |`);
  lines.push("");
  return lines.join("\n");
}

function main() {
  const objects = loadRegistry();
  const withCapmapDomain = objects.filter((o) => tagValue(o, "capmap-domain"));

  const lines = [];
  lines.push("# Cripto10 — Capability Map");
  lines.push("");
  lines.push(`_Gerado automaticamente por \`npm run capability-map\` em ${new Date().toISOString()} a partir de \`registry/research-objects.json\` (${objects.length} Research Objects, ${withCapmapDomain.length} mapeados). Não editar este arquivo à mão._`);
  lines.push("");
  lines.push("## Objetivo");
  lines.push("");
  lines.push("Este documento é o mapa vivo de capacidades do cripto10. Não é um roadmap, não é um backlog, não é documentação técnica -- responde só uma pergunta: **\"o que o sistema é capaz de fazer?\"**. Cada capability aponta pro seu Research Object correspondente, estado de maturidade, consumidores reais e dependências -- tudo derivado do Feature Registry, nada duplicado.");
  lines.push("");

  for (const domain of DOMAIN_ORDER) {
    const inDomain = withCapmapDomain.filter((o) => tagValue(o, "capmap-domain") === domain);
    if (inDomain.length === 0) continue;

    lines.push(`## ${DOMAIN_LABEL[domain]}`);
    lines.push("");

    const subdomains = [...new Set(inDomain.map((o) => tagValue(o, "capmap-subdomain") || "Geral"))];
    for (const subdomain of subdomains) {
      const inSubdomain = inDomain.filter((o) => (tagValue(o, "capmap-subdomain") || "Geral") === subdomain).sort((a, b) => a.id.localeCompare(b.id));
      lines.push(`### ${subdomain}`);
      lines.push("");
      for (const obj of inSubdomain) {
        lines.push(card(obj, objects));
      }
    }
  }

  lines.push("## Legenda — Capability Stage");
  lines.push("");
  lines.push("💡 Idea · 📚 Research · 🧪 Prototype · 🔁 Replay · ✅ Validated · 🚀 Production · 🛠 Deprecated");
  lines.push("");

  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.log(`Gravado: ${OUT_PATH} (${withCapmapDomain.length} capabilities em ${DOMAIN_ORDER.length} domínios)`);
}

main();

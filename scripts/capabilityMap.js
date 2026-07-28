// Gera research/capability-map.md a partir do Feature Registry -- nunca
// editar o .md à mão, mesma disciplina de adoptionMatrix.js/dnaMatrix.js.
// Pergunta diferente das outras duas: não "de onde veio" nem "combina com
// os princípios", mas "onde é que isso mora arquiteturalmente, e em que
// estágio está" -- existe pra que o Registry (85+ Research Objects e
// crescendo) não vire um mapa escondido que só quem escreveu entende.
const fs = require("fs");
const path = require("path");
const { loadRegistry } = require("../lib/registry/registryStore");

const OUT_PATH = path.join(__dirname, "..", "research", "capability-map.md");

const DOMAIN_ORDER = ["knowledge", "analysis", "discovery", "research"];
const DOMAIN_LABEL = { knowledge: "Knowledge", analysis: "Analysis", discovery: "Discovery", research: "Research" };

const STATUS_BUCKET = {
  production: "Implemented",
  validated: "Implemented",
  research: "Research",
  idea: "Idea",
  backlog: "Roadmap",
  rejected: "Deprecated",
  deprecated: "Deprecated",
};
const BUCKET_ORDER = ["Implemented", "Research", "Roadmap", "Idea", "Deprecated"];

function tagValue(obj, prefix) {
  const tag = obj.tags.find((t) => t.startsWith(prefix + ":"));
  return tag ? tag.split(":").slice(1).join(":") : null;
}

function bucketOf(obj) {
  return STATUS_BUCKET[obj.status] || "Idea";
}

function main() {
  const objects = loadRegistry();
  const withDomain = objects.filter((o) => tagValue(o, "domain"));
  const withoutDomain = objects.filter((o) => !tagValue(o, "domain"));

  const lines = [];
  lines.push("# Capability Map");
  lines.push("");
  lines.push(`_Gerado automaticamente por \`npm run capability-map\` em ${new Date().toISOString()} a partir de \`registry/research-objects.json\` (${objects.length} Research Objects, ${withDomain.length} com domínio classificado). Não editar este arquivo à mão._`);
  lines.push("");
  lines.push("Pergunta que este mapa responde: **onde é que isso mora arquiteturalmente, e em que estágio está** -- não \"de onde veio\" (Adoption Matrix) nem \"combina com os princípios\" (DNA Matrix). Um componente aparece uma vez só, no domínio do seu `domain:*` tag, agrupado por estágio (Implemented/Research/Roadmap/Idea/Deprecated -- derivado do `status` do Registry, não um campo à parte).");
  lines.push("");

  for (const domain of DOMAIN_ORDER) {
    const inDomain = withDomain.filter((o) => tagValue(o, "domain") === domain);
    if (inDomain.length === 0) continue;

    lines.push(`## ${DOMAIN_LABEL[domain]}`);
    lines.push("");
    for (const bucket of BUCKET_ORDER) {
      const inBucket = inDomain.filter((o) => bucketOf(o) === bucket).sort((a, b) => a.id.localeCompare(b.id));
      if (inBucket.length === 0) continue;
      lines.push(`**${bucket}**`);
      for (const obj of inBucket) {
        lines.push(`- \`${obj.id}\` -- ${obj.name}`);
      }
      lines.push("");
    }
  }

  lines.push("## Sem domínio classificado ainda");
  lines.push("");
  lines.push("Ideias de execução/risco/infra (Risk Guard Pipeline, Executor state machine, multi-exchange...) e indicadores/features clássicos não entram nos 4 domínios acima de propósito -- não são camada de conhecimento/análise/descoberta/pesquisa, são infraestrutura de execução ou blocos de indicador. Contagem: " + withoutDomain.length + ".");
  lines.push("");

  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.log(`Gravado: ${OUT_PATH} (${withDomain.length} objetos mapeados em ${DOMAIN_ORDER.length} domínios)`);
}

main();

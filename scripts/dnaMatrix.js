// Gera research/dna-matrix.md a partir do Feature Registry -- nunca editar
// o .md à mão, mesma disciplina de scripts/adoptionMatrix.js. Diferente da
// Adoption Matrix (que pergunta "essa ideia veio de onde e com que
// prioridade"), a DNA Matrix pergunta "essa ideia/padrão combina com os
// princípios do cripto10" -- DNA Fit é alinhamento FILOSÓFICO (0-100%),
// independente de já valer a pena construir agora (isso é a classificação
// + custo de manutenção, eixos separados de propósito).
const fs = require("fs");
const path = require("path");
const { loadRegistry } = require("../lib/registry/registryStore");

const OUT_PATH = path.join(__dirname, "..", "research", "dna-matrix.md");

const CLASSIFICATION_LABEL = {
  superior: "SUPERIOR",
  inspirador: "INSPIRADOR",
  complementar: "COMPLEMENTAR",
  equivalente: "EQUIVALENTE",
  "nao-necessario": "NÃO NECESSÁRIO",
  "contrario-aos-principios": "CONTRÁRIO AOS PRINCÍPIOS",
};
const MAINTENANCE_LABEL = { low: "Baixo", medium: "Médio", high: "Alto", "n/a": "--" };
const CLASSIFICATION_ORDER = ["superior", "inspirador", "complementar", "equivalente", "nao-necessario", "contrario-aos-principios"];

function tagValue(obj, prefix) {
  const tag = obj.tags.find((t) => t.startsWith(prefix + ":"));
  return tag ? tag.split(":").slice(1).join(":") : null;
}

function row(obj) {
  const fit = tagValue(obj, "dna-fit");
  const maintenance = tagValue(obj, "maintenance-cost");
  const domain = tagValue(obj, "domain");
  return `| \`${obj.id}\` | ${obj.name} | ${fit ? fit + "%" : "--"} | ${MAINTENANCE_LABEL[maintenance] || "--"} | ${domain || "--"} |`;
}

function main() {
  const objects = loadRegistry();
  const scored = objects.filter((o) => o.tags.some((t) => t.startsWith("dna-fit:")));

  const lines = [];
  lines.push("# DNA Matrix");
  lines.push("");
  lines.push(`_Gerado automaticamente por \`npm run dna-matrix\` em ${new Date().toISOString()} a partir de \`registry/research-objects.json\` (${scored.length} objetos com DNA Fit calculado, de ${objects.length} totais). Não editar este arquivo à mão._`);
  lines.push("");
  lines.push("Pergunta que este documento responde: **essa ideia/padrão combina com os princípios do cripto10** (Replay antes de promoção, evidência antes de decisão, Brains desacoplados, contexto antes de entrada, estatística antes de automação)? DNA Fit é alinhamento filosófico -- não é a mesma pergunta que \"vale a pena construir agora\" (isso é a Classificação) nem \"quanto custa manter\" (Custo de Manutenção). Uma ideia pode ter DNA Fit alto e ainda assim ser `NÃO NECESSÁRIO` hoje, se não houver consumidor real -- ver `research/competitor-intelligence/openalice.md` e o artifact \"Engineering Patterns\" pro raciocínio por trás de cada score.");
  lines.push("");

  for (const key of CLASSIFICATION_ORDER) {
    const group = scored.filter((o) => tagValue(o, "classification") === key);
    if (group.length === 0) continue;
    lines.push(`## ${CLASSIFICATION_LABEL[key]}`);
    lines.push("");
    lines.push("| id | nome | DNA Fit | custo de manutenção | domínio |");
    lines.push("|---|---|---|---|---|");
    for (const obj of group.sort((a, b) => Number(tagValue(b, "dna-fit")) - Number(tagValue(a, "dna-fit")))) {
      lines.push(row(obj));
    }
    lines.push("");
  }

  lines.push("## Domínios (resposta à crítica \"muitos motores horizontais\")");
  lines.push("");
  const domains = ["research", "knowledge", "analysis", "discovery"];
  const domainNames = { research: "Research Layer", knowledge: "Knowledge Layer", analysis: "Analysis Layer", discovery: "Discovery Layer" };
  for (const d of domains) {
    const group = objects.filter((o) => tagValue(o, "domain") === d).sort((a, b) => a.id.localeCompare(b.id));
    if (group.length === 0) continue;
    lines.push(`### ${domainNames[d]}`);
    lines.push("");
    lines.push(group.map((o) => `\`${o.id}\``).join(", "));
    lines.push("");
  }

  fs.writeFileSync(OUT_PATH, lines.join("\n") + "\n");
  console.log(`Gravado: ${OUT_PATH} (${scored.length} objetos com DNA Fit)`);
}

main();

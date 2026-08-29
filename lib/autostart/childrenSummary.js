// Só consome lib/supervisorProfile.js (fonte canônica única) pra dar aos
// scripts PowerShell de autostart o mesmo dado que scripts/supervisor.js já
// usa -- nunca uma segunda lista hardcoded e divergente. Puro, sem I/O
// próprio além do require.
const { ALL_CHILDREN, selectSupervisedChildren } = require("../supervisorProfile");

/**
 * Nomes/scripts de TODOS os processos conhecidos (qualquer categoria) --
 * usado pelo Stop.ps1 pra validar/limpar órfãos com segurança: um PID só
 * pode ser tocado se corresponder a um `script` desta lista, e "bot"
 * (category "trading") é explicitamente marcado pra nunca ser tocado por
 * um wrapper que só sabe operar o perfil "safe".
 */
function getAllChildrenSummary() {
  return ALL_CHILDREN.map((c) => ({ name: c.name, script: c.script, category: c.category }));
}

/**
 * Só os processos do perfil "safe", já filtrados por dependência opcional
 * (ex.: knowledge_collector sem API key) -- exatamente o que Start.ps1
 * deveria esperar ver rodando, e o que Status.ps1 deveria reportar como
 * "componentes seguros esperados".
 */
function getSafeChildrenSummary(env = process.env) {
  const { children, skipped } = selectSupervisedChildren("safe", env);
  return {
    children: children.map((c) => ({ name: c.name, script: c.script })),
    skipped,
  };
}

module.exports = { getAllChildrenSummary, getSafeChildrenSummary };

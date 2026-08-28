// Seleção pura e testável dos processos que scripts/supervisor.js deve
// subir, a partir de SUPERVISOR_PROFILE. Lista canônica ÚNICA de processos
// conhecidos -- scripts/supervisor.js importa ALL_CHILDREN/
// selectSupervisedChildren daqui, nunca mantém uma lista paralela própria.
const path = require("path");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");

// category "safe" -- nunca chama contas/ordens da Bybit, elegível pro
// perfil "safe". category "trading" -- é o bot ou algo que pode chamar
// contas/ordens; NUNCA entra no perfil "safe", e mesmo fora dele continua
// protegido pelo gate financeiro independente (lib/tradingExecutionGate.js)
// em lib/bybit.js -- este módulo só decide QUAIS PROCESSOS SOBEM, nunca é
// a única linha de defesa contra execução financeira.
//
// `isReady(env)` -- checagem opcional de dependência (ex.: API keys) pra
// componentes opcionais; ausente = sempre pronto.
const ALL_CHILDREN = [
  { name: "bot", script: path.join(__dirname, "..", "index.js"), category: "trading" },
  { name: "bybit_collector", script: path.join(SCRIPTS_DIR, "collector.js"), category: "safe" },
  { name: "fear_greed_collector", script: path.join(SCRIPTS_DIR, "fearGreedCollector.js"), category: "safe" },
  { name: "btc_dominance_collector", script: path.join(SCRIPTS_DIR, "btcDominanceCollector.js"), category: "safe" },
  {
    name: "knowledge_collector",
    script: path.join(SCRIPTS_DIR, "knowledgeCollector.js"),
    category: "safe",
    isReady: (env) => Boolean(env.FRED_API_KEY) && Boolean(env.COINMARKETCAL_API_KEY),
  },
  { name: "metrics_sampler", script: path.join(SCRIPTS_DIR, "metricsSampler.js"), category: "safe" },
  { name: "backup_daemon", script: path.join(SCRIPTS_DIR, "backupDaemon.js"), category: "safe" },
  { name: "dashboard_server", script: path.join(SCRIPTS_DIR, "dashboardServer.js"), category: "safe" },
];

// Hoje só "safe" existe -- nenhum perfil operacional (com "bot") foi criado
// ainda. Adicionar um novo nome aqui é o único jeito de torná-lo aceitável;
// qualquer outro valor lança (ver resolveSupervisorProfile).
const VALID_PROFILES = ["safe"];

class SupervisorProfileError extends Error {
  constructor(rawValue) {
    super(`SUPERVISOR_PROFILE inválido (${JSON.stringify(rawValue)}) -- valores aceitos: ${VALID_PROFILES.join(", ")}`);
    this.name = this.constructor.name;
    this.code = "SUPERVISOR_PROFILE_INVALID";
  }
}

/**
 * Resolve o nome do perfil a partir do ambiente. Ausente/vazio -> "safe"
 * (default seguro). Qualquer valor não reconhecido -> lança
 * SupervisorProfileError (mesmo padrão estrito já usado por
 * AGENTROUTER_BUDGET_ENABLED em config.js para flags sensíveis: superfície
 * que decide QUAIS PROCESSOS SOBEM nunca deveria aceitar um valor não
 * reconhecido silenciosamente -- é mais seguro e mais testável falhar alto
 * e explícito do que assumir "safe" por engano de configuração e dar falsa
 * confiança de que outro perfil estava rodando).
 */
function resolveSupervisorProfile(env = process.env) {
  const raw = env.SUPERVISOR_PROFILE;
  if (raw === undefined || raw === "") return "safe";
  if (VALID_PROFILES.includes(raw)) return raw;
  throw new SupervisorProfileError(raw);
}

/**
 * Devolve { children, skipped } para o perfil dado. `children` é a lista
 * final (nome+script) que o supervisor deve subir. `skipped` documenta,
 * com motivo estável (nunca segredo/valor de env), quem ficou de fora --
 * um componente opcional sem configuração válida nunca derruba os demais.
 */
function selectSupervisedChildren(profile, env = process.env) {
  if (!VALID_PROFILES.includes(profile)) {
    throw new SupervisorProfileError(profile); // defesa em profundidade -- resolveSupervisorProfile já teria lançado antes
  }
  const children = [];
  const skipped = [];
  for (const child of ALL_CHILDREN) {
    if (profile === "safe" && child.category !== "safe") {
      skipped.push({ name: child.name, reason: `categoria "${child.category}" não elegível pro perfil "${profile}"` });
      continue;
    }
    if (child.isReady && !child.isReady(env)) {
      skipped.push({ name: child.name, reason: "dependência de configuração ausente" });
      continue;
    }
    children.push({ name: child.name, script: child.script });
  }
  return { children, skipped };
}

module.exports = {
  ALL_CHILDREN,
  VALID_PROFILES,
  SupervisorProfileError,
  resolveSupervisorProfile,
  selectSupervisedChildren,
};

// Validação estrita da porta de bind do dashboard -- deliberadamente
// diferente de num() (config.js), que é permissivo por design (qualquer
// valor não numérico vira o fallback silenciosamente). Bind de rede é
// superfície sensível o bastante pra nunca aceitar um valor inválido dessa
// forma: ausente/vazio usa o default documentado; qualquer OUTRO valor
// precisa ser um inteiro estrito dentro do intervalo permitido, senão
// lança -- nunca escolhe outra porta por conta própria.
const DEFAULT_DASHBOARD_PORT = 4300;
const MIN_DASHBOARD_PORT = 1024; // evita portas privilegiadas/bem-conhecidas por engano de configuração
const MAX_DASHBOARD_PORT = 65535;

// Único host aceito -- nunca 0.0.0.0/::/hostname automático/interface de
// rede local. Constante, não configurável por env nesta rodada (o pedido é
// bind EXCLUSIVO em loopback, não "loopback por padrão").
const DASHBOARD_BIND_HOST = "127.0.0.1";

class DashboardPortError extends Error {
  constructor(rawValue) {
    super(`DASHBOARD_PORT inválido (${JSON.stringify(rawValue)}) -- precisa ser um inteiro entre ${MIN_DASHBOARD_PORT} e ${MAX_DASHBOARD_PORT}`);
    this.name = this.constructor.name;
    this.code = "DASHBOARD_PORT_INVALID";
  }
}

/**
 * Ausente/vazio -> DEFAULT_DASHBOARD_PORT (default documentado, não é
 * "silencioso" -- é o comportamento esperado e testado). Qualquer outro
 * valor precisa casar `^\d+$` (só dígitos -- rejeita decimal, sinal,
 * espaço, notação científica) E estar dentro do intervalo permitido;
 * senão lança DashboardPortError, nunca cai de volta pro default.
 */
function resolveDashboardPort(env = process.env) {
  const raw = env.DASHBOARD_PORT;
  if (raw === undefined || raw === "") return DEFAULT_DASHBOARD_PORT;
  if (!/^\d+$/.test(raw)) throw new DashboardPortError(raw);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_DASHBOARD_PORT || port > MAX_DASHBOARD_PORT) {
    throw new DashboardPortError(raw);
  }
  return port;
}

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  MIN_DASHBOARD_PORT,
  MAX_DASHBOARD_PORT,
  DASHBOARD_BIND_HOST,
  DashboardPortError,
  resolveDashboardPort,
};

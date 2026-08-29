// Gate estrutural do perfil "demo" -- responde SÓ a uma pergunta: a
// configuração atual do ambiente autoriza chamadas PRIVADAS contra
// api-demo.bybit.com? Ortogonal a lib/tradingExecutionGate.js (que continua
// sendo a autorização de "pode chamar API privada, ponto"): este módulo
// decide qual DESTINO essa chamada privada pode ter, nunca se ela pode
// acontecer -- as duas responsabilidades continuam separadas, exatamente
// como o comentário de lib/tradingExecutionGate.js já documenta pra
// BYBIT_DEMO/BYBIT_TESTNET/credenciais.
//
// Contrato: qualquer configuração ausente, ambígua, incompleta ou com
// capitalização/formatação inesperada -> lança ANTES de qualquer HMAC,
// Axios, WebSocket ou spawn de scripts/bot. Nunca "corrige" a intenção do
// operador, nunca cai pra Testnet/Mainnet silenciosamente. Comparação
// estrita (===), nunca reutiliza config.js::bool() (permissivo por design,
// documentado ali mesmo como não-usado por este módulo).
//
// Reimplementa a resolução do endpoint (em vez de importar lib/bybit.js)
// de propósito: lib/bybit.js calcula BASE_URL uma ÚNICA vez, no
// require() do módulo -- por já ter sido computado antes de qualquer
// validação deste arquivo rodar, não pode ser a fonte de verdade da
// checagem "o endpoint é mesmo o de Demo?". Este resolvedor é
// independente, sempre recalculado a partir do env atual.
const DEMO_PROFILE_NAME = "demo";
const DEMO_BASE_URL = "https://api-demo.bybit.com";
const TESTNET_BASE_URL = "https://api-testnet.bybit.com";
const MAINNET_BASE_URL = "https://api.bybit.com";

const STRICT_TRUE = "true";
const STRICT_FALSE = "false";

class DemoTradingGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}
class DemoFlagInvalidError extends DemoTradingGateError {
  constructor(field) {
    super("DEMO_FLAG_INVALID", `${field} precisa ser exatamente "${field === "BYBIT_DEMO" ? STRICT_TRUE : STRICT_FALSE}" para o perfil demo -- qualquer outro valor (ausente, vazio, capitalização diferente) bloqueia antes de qualquer chamada.`);
    this.field = field;
  }
}
class DemoEndpointMismatchError extends DemoTradingGateError {
  constructor(resolvedUrl) {
    super("DEMO_ENDPOINT_MISMATCH", `Endpoint resolvido não é api-demo.bybit.com (resolvido para um destino diferente) -- bloqueado antes de qualquer chamada. Endpoint exigido: ${DEMO_BASE_URL}`);
    // NUNCA inclui resolvedUrl na mensagem pública -- os únicos 3 valores
    // possíveis (demo/testnet/mainnet) já são de baixo risco, mas a
    // disciplina do projeto é nunca interpolar dado dinâmico em mensagem
    // pública sem necessidade (mesmo padrão de TradingExecutionBlockedError).
    this.resolvedUrl = resolvedUrl;
  }
}
class DemoCredentialsMissingError extends DemoTradingGateError {
  constructor(field) {
    super("DEMO_CREDENTIALS_MISSING", `${field} ausente ou vazio -- perfil demo exige credenciais próprias da conta Demo Trading, nunca reaproveita chave de outro ambiente.`);
    this.field = field;
  }
}

/**
 * Resolução ESTRITA e independente do endpoint REST privado, a partir do
 * env atual -- nunca lê config.js/lib/bybit.js. Mesma precedência de
 * lib/bybit.js (demo > testnet > mainnet), mas com comparação estrita
 * (=== "true"/"false") em vez do bool() permissivo de config.js.
 */
function resolveStrictBaseUrl(env) {
  const demoRaw = env.BYBIT_DEMO;
  const testnetRaw = env.BYBIT_TESTNET;
  if (demoRaw === STRICT_TRUE) return DEMO_BASE_URL;
  if (testnetRaw === STRICT_TRUE) return TESTNET_BASE_URL;
  return MAINNET_BASE_URL;
}

/**
 * Valida TODAS as condições exigidas para o perfil demo poder operar.
 * Lança no PRIMEIRO problema encontrado (ordem estável, não importa pra
 * segurança -- todas são checadas antes de qualquer rede de qualquer
 * forma, então "qual lança primeiro" só afeta a mensagem, nunca o
 * resultado). Nunca inclui valor de segredo na mensagem/erro.
 */
function validateDemoBoot(env = process.env) {
  if (env.BYBIT_DEMO !== STRICT_TRUE) throw new DemoFlagInvalidError("BYBIT_DEMO");
  if (env.BYBIT_TESTNET !== STRICT_FALSE) throw new DemoFlagInvalidError("BYBIT_TESTNET");

  const resolvedUrl = resolveStrictBaseUrl(env);
  if (resolvedUrl !== DEMO_BASE_URL) throw new DemoEndpointMismatchError(resolvedUrl);

  if (!env.BYBIT_API_KEY || env.BYBIT_API_KEY.trim() === "") throw new DemoCredentialsMissingError("BYBIT_API_KEY");
  if (!env.BYBIT_API_SECRET || env.BYBIT_API_SECRET.trim() === "") throw new DemoCredentialsMissingError("BYBIT_API_SECRET");

  return true;
}

/**
 * Versão booleana, nunca lança -- usada por lib/supervisorProfile.js::isReady
 * (que só precisa saber sim/não pra decidir se "bot" entra na lista de
 * filhos do perfil demo) e por qualquer chamador que prefira checar antes
 * de decidir se tenta o boot de verdade.
 */
function isDemoBootValid(env = process.env) {
  try {
    validateDemoBoot(env);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEMO_PROFILE_NAME,
  DEMO_BASE_URL,
  TESTNET_BASE_URL,
  MAINNET_BASE_URL,
  resolveStrictBaseUrl,
  validateDemoBoot,
  isDemoBootValid,
  DemoTradingGateError,
  DemoFlagInvalidError,
  DemoEndpointMismatchError,
  DemoCredentialsMissingError,
};

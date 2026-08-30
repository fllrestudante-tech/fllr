// Modo de execução dentro do perfil demo -- responde SÓ a uma pergunta:
// o bot pode CHAMAR funções mutáveis (placeOrder/setLeverage/
// setTradingStop/cancel*) neste boot, ou só analisar/observar? Ortogonal
// a lib/demoTradingGate.js (que decide se o DESTINO é api-demo.bybit.com)
// e a lib/tradingExecutionGate.js (que continua sendo a ÚNICA autorização
// de baixo nível que de fato libera uma chamada privada mutável, dentro
// de lib/bybit.js::privatePost -- este módulo nunca substitui aquele
// gate, só decide se o CÓDIGO DO BOT (index.js) sequer tenta chamar).
//
// Contrato estrito, mesmo padrão de lib/demoTradingGate.js: ausente,
// vazio, capitalização inesperada ou qualquer valor que não seja
// EXATAMENTE um dos dois literais abaixo -> lança. Nunca assume
// "observe" por omissão silenciosa -- omitir a variável é uma
// configuração incompleta, não uma intenção implícita de observar.
const EXECUTION_MODES = Object.freeze({
  OBSERVE: "observe",
  EXECUTION: "execution",
});
const VALID_EXECUTION_MODES = new Set(Object.values(EXECUTION_MODES));

class DemoExecutionModeInvalidError extends Error {
  constructor(rawValue) {
    super(
      `DEMO_EXECUTION_MODE inválido (${JSON.stringify(rawValue)}) -- valores aceitos: ${Object.values(EXECUTION_MODES).join(", ")}. Exigido explicitamente no perfil demo -- nunca assumido por omissão.`
    );
    this.name = this.constructor.name;
    this.code = "DEMO_EXECUTION_MODE_INVALID";
  }
}

/**
 * Lança DemoExecutionModeInvalidError pra qualquer valor que não seja
 * EXATAMENTE "observe" ou "execution" -- inclusive ausente/vazio. Nunca
 * lê SUPERVISOR_PROFILE aqui (não é responsabilidade deste módulo saber
 * se está no perfil demo -- quem chama decide QUANDO essa checagem
 * importa, mesmo padrão de lib/demoTradingGate.js::validateDemoBoot ser
 * chamado só depois do perfil já ter sido confirmado como "demo").
 */
function resolveDemoExecutionMode(env = process.env) {
  const raw = env.DEMO_EXECUTION_MODE;
  if (VALID_EXECUTION_MODES.has(raw)) return raw;
  throw new DemoExecutionModeInvalidError(raw);
}

/** Versão booleana, nunca lança -- usada por leitores read-only (dashboard/health) que preferem um rótulo estável a uma exceção. */
function safeResolveDemoExecutionMode(env = process.env) {
  try {
    return resolveDemoExecutionMode(env);
  } catch {
    return null;
  }
}

module.exports = {
  EXECUTION_MODES,
  VALID_EXECUTION_MODES,
  DemoExecutionModeInvalidError,
  resolveDemoExecutionMode,
  safeResolveDemoExecutionMode,
};

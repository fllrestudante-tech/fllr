// Gate financeiro fail-closed -- única autorização que permite chamadas
// PRIVADAS (conta/ordens/stops) à Bybit. Independente de quem chama --
// index.js via supervisor, index.js executado diretamente, ou qualquer
// script futuro que importe lib/bybit.js.
//
// Contrato estrito, deliberadamente diferente de bool() (config.js), que é
// permissivo por design: aqui, ausente, vazio, capitalização inesperada ou
// qualquer valor que não seja EXATAMENTE o literal abaixo -> SEMPRE false,
// nunca lança, nunca tenta "corrigir" a intenção do operador. Não existe
// fallback que habilite execução -- só a igualdade estrita.
//
// BYBIT_DEMO/BYBIT_TESTNET e a presença de BYBIT_API_KEY/BYBIT_API_SECRET
// são ORTOGONAIS a este gate -- decidem só qual endpoint seria chamado
// (demo/testnet/mainnet), nunca se a chamada privada pode acontecer.
const TRADING_EXECUTION_ENABLED_ENV_VAR = "TRADING_EXECUTION_ENABLED";
const STRICT_ENABLE_VALUE = "true";

function isTradingExecutionEnabled(env = process.env) {
  return env[TRADING_EXECUTION_ENABLED_ENV_VAR] === STRICT_ENABLE_VALUE;
}

// Mensagem pública estável -- nunca inclui o valor recebido nem qualquer
// credencial; só nomeia a variável e o literal exigido.
class TradingExecutionBlockedError extends Error {
  constructor() {
    super(
      `Trading execution is disabled. Set ${TRADING_EXECUTION_ENABLED_ENV_VAR}=${STRICT_ENABLE_VALUE} explicitly to allow private Bybit calls (account/orders/stops). BYBIT_DEMO, BYBIT_TESTNET and API credentials do not substitute this authorization.`
    );
    this.name = this.constructor.name;
    this.code = "TRADING_EXECUTION_BLOCKED";
  }
}

// Lança ANTES de qualquer chamada de rede -- chamado no topo de
// privateGet/privatePost (lib/bybit.js), antes de withRetry/axios. Como
// essas funções são `async`, lançar aqui (síncrono) já vira uma promise
// rejeitada, sem nenhum retry sendo engatado.
function assertTradingExecutionEnabled(env = process.env) {
  if (!isTradingExecutionEnabled(env)) {
    throw new TradingExecutionBlockedError();
  }
}

module.exports = {
  TRADING_EXECUTION_ENABLED_ENV_VAR,
  STRICT_ENABLE_VALUE,
  isTradingExecutionEnabled,
  assertTradingExecutionEnabled,
  TradingExecutionBlockedError,
};

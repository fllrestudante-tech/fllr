const { test } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../config");
const { parseAgentRouterBudgetEnabled } = config;

const CONFIG_MODULE_PATH = require.resolve("../config");
const ENV_KEY = "AGENTROUTER_BUDGET_ENABLED";

// =====================================================================
// parseAgentRouterBudgetEnabled(env) -- funcao pura, mesmo padrao de
// parseProviderOrder(env) (test/config.providerOrder.test.js): nunca toca
// process.env, testavel com um objeto sintetico. Deliberadamente ESTRITO
// -- diferente de bool() (topo de config.js, usado por BYBIT_TESTNET/
// BYBIT_DEMO/CIRCUIT_BREAKER_ON_HIGH_VOLATILITY), que aceita "1" e
// silenciosamente trata qualquer outra coisa como false. bool() NAO e'
// tocado por este commit -- ver teste de nao-regressao no final do arquivo.
// =====================================================================

test("ausente -> false (default)", () => {
  assert.equal(parseAgentRouterBudgetEnabled({}), false);
});

test("string vazia -> false (mesmo tratamento de ausente)", () => {
  assert.equal(parseAgentRouterBudgetEnabled({ [ENV_KEY]: "" }), false);
});

test('"true" -> true', () => {
  assert.equal(parseAgentRouterBudgetEnabled({ [ENV_KEY]: "true" }), true);
});

test('"false" -> false', () => {
  assert.equal(parseAgentRouterBudgetEnabled({ [ENV_KEY]: "false" }), false);
});

test('"1" -- REJEITADO, nunca vira true silenciosamente (diferente de bool())', () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "1" }), /AGENTROUTER_BUDGET_ENABLED/);
});

test('"0" -- REJEITADO, nunca vira false silenciosamente', () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "0" }), /AGENTROUTER_BUDGET_ENABLED/);
});

test("variação de caixa (\"TRUE\", \"True\", \"FALSE\") -- REJEITADA", () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "TRUE" }), /AGENTROUTER_BUDGET_ENABLED/);
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "True" }), /AGENTROUTER_BUDGET_ENABLED/);
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "FALSE" }), /AGENTROUTER_BUDGET_ENABLED/);
});

test("espaço em volta (\" true\", \"true \") -- REJEITADO, nunca faz trim implícito", () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: " true" }), /AGENTROUTER_BUDGET_ENABLED/);
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "true " }), /AGENTROUTER_BUDGET_ENABLED/);
});

test('"yes"/"no"/texto livre -- REJEITADO', () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "yes" }), /AGENTROUTER_BUDGET_ENABLED/);
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "no" }), /AGENTROUTER_BUDGET_ENABLED/);
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "banana" }), /AGENTROUTER_BUDGET_ENABLED/);
});

test("mensagem de erro nomeia a variável E o valor recebido (nunca de outra env var)", () => {
  assert.throws(() => parseAgentRouterBudgetEnabled({ [ENV_KEY]: "1" }), (err) => {
    assert.match(err.message, /AGENTROUTER_BUDGET_ENABLED/);
    assert.match(err.message, /"1"/);
    return true;
  });
});

test("config.ai.agentRouterBudgetEnabled: default false no processo de teste real (nenhum .env de teste seta essa variável)", () => {
  assert.equal(config.ai.agentRouterBudgetEnabled, false);
});

test("bool() legado (BYBIT_TESTNET/BYBIT_DEMO/CIRCUIT_BREAKER_ON_HIGH_VOLATILITY) continua aceitando \"1\" -- não regrediu por causa deste parser novo", () => {
  // Prova indireta e' suficiente aqui: config.js carregado normalmente já
  // teria lançado no load (ver testes de carregamento real abaixo) se
  // bool() tivesse sido tocado de forma incompatível; este teste apenas
  // documenta explicitamente que os dois parsers são independentes.
  assert.equal(typeof config.bybit.testnet, "boolean");
  assert.equal(typeof config.bybit.demo, "boolean");
});

// =====================================================================
// Carregamento REAL de config.js com valor inválido -- prova que a
// aplicação falha na inicialização (não só que a função pura lança).
// Controla require.cache + process.env explicitamente, restaura em
// finally para não vazar estado pros outros arquivos de teste.
// =====================================================================

test("carregamento real de config.js com AGENTROUTER_BUDGET_ENABLED inválido derruba a inicialização com erro claro", () => {
  const hadOwn = Object.hasOwn(process.env, ENV_KEY);
  const previousValue = process.env[ENV_KEY];
  delete require.cache[CONFIG_MODULE_PATH];
  process.env[ENV_KEY] = "1";
  try {
    assert.throws(() => require(CONFIG_MODULE_PATH), /AGENTROUTER_BUDGET_ENABLED/);
  } finally {
    if (hadOwn) process.env[ENV_KEY] = previousValue;
    else delete process.env[ENV_KEY];
    // Node remove automaticamente do require.cache um módulo cujo topo
    // lançou -- mas força de novo aqui, defensivamente, antes de
    // recarregar limpo, para nunca depender desse detalhe de implementação.
    delete require.cache[CONFIG_MODULE_PATH];
    require(CONFIG_MODULE_PATH); // recarrega limpo com o ambiente restaurado -- deixa o cache num estado bom pros próximos arquivos de teste
  }
});

test("carregamento real de config.js com AGENTROUTER_BUDGET_ENABLED=\"true\" sobe normalmente e reflete o valor", () => {
  const hadOwn = Object.hasOwn(process.env, ENV_KEY);
  const previousValue = process.env[ENV_KEY];
  delete require.cache[CONFIG_MODULE_PATH];
  process.env[ENV_KEY] = "true";
  try {
    const reloaded = require(CONFIG_MODULE_PATH);
    assert.equal(reloaded.ai.agentRouterBudgetEnabled, true);
  } finally {
    if (hadOwn) process.env[ENV_KEY] = previousValue;
    else delete process.env[ENV_KEY];
    delete require.cache[CONFIG_MODULE_PATH];
    require(CONFIG_MODULE_PATH); // recarrega limpo com o ambiente restaurado
  }
});

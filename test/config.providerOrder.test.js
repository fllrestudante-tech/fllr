const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../config");

const { parseProviderOrder } = config;

test("sem AI_PROVIDER_ORDER e sem legado -- default anthropic -> openai", () => {
  assert.deepEqual(parseProviderOrder({}), ["anthropic", "openai"]);
});

test("explícito com os 3 providers, na ordem informada", () => {
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "agentrouter,anthropic,openai" }), ["agentrouter", "anthropic", "openai"]);
});

test("explícito: espaços em volta de cada entrada são removidos (trim)", () => {
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "  agentrouter , anthropic  ,openai " }), ["agentrouter", "anthropic", "openai"]);
});

test("explícito: entradas duplicadas são removidas, preservando a primeira ocorrência (dedupe)", () => {
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "anthropic,anthropic,openai,anthropic" }), ["anthropic", "openai"]);
});

test("explícito: provider desconhecido lança erro claro nomeando o provider", () => {
  assert.throws(() => parseProviderOrder({ AI_PROVIDER_ORDER: "agentrouter,foo" }), /provider desconhecido "foo"/);
});

test("explícito: string só de vírgulas (\",,,\") lança em vez de desligar a IA silenciosamente", () => {
  assert.throws(() => parseProviderOrder({ AI_PROVIDER_ORDER: ",,," }), /nenhuma entrada válida informada/);
});

test("explícito: string vazia ou só espaço não conta como AI_PROVIDER_ORDER setado -- cai pro legado", () => {
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "" }), ["anthropic", "openai"]);
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "   " }), ["anthropic", "openai"]);
});

test("fallback legado: AI_PRIMARY_PROVIDER/AI_SECONDARY_PROVIDER usados quando AI_PROVIDER_ORDER ausente", () => {
  assert.deepEqual(parseProviderOrder({ AI_PRIMARY_PROVIDER: "openai", AI_SECONDARY_PROVIDER: "agentrouter" }), ["openai", "agentrouter"]);
});

test("fallback legado: só AI_PRIMARY_PROVIDER setado -- AI_SECONDARY_PROVIDER cai no default openai", () => {
  assert.deepEqual(parseProviderOrder({ AI_PRIMARY_PROVIDER: "agentrouter" }), ["agentrouter", "openai"]);
});

test("fallback legado: provider desconhecido também lança (mesma validação, independente da origem)", () => {
  assert.throws(() => parseProviderOrder({ AI_PRIMARY_PROVIDER: "bedrock" }), /provider desconhecido "bedrock"/);
});

test("AI_PROVIDER_ORDER com um único provider é aceito", () => {
  assert.deepEqual(parseProviderOrder({ AI_PROVIDER_ORDER: "agentrouter" }), ["agentrouter"]);
});

test("env ausente (undefined) usa default sem lançar", () => {
  assert.deepEqual(parseProviderOrder(), ["anthropic", "openai"]);
  assert.deepEqual(parseProviderOrder(undefined), ["anthropic", "openai"]);
});

test("config.parseProviderOrder é uma função, mas NÃO enumerável em Object.keys(config)/config.ai", () => {
  assert.equal(typeof config.parseProviderOrder, "function");
  assert.equal(Object.keys(config).includes("parseProviderOrder"), false);
  assert.equal(JSON.stringify(config).includes("parseProviderOrder"), false);
});

test("config real (processo atual): providerOrder/primaryProvider/secondaryProvider derivados corretamente", () => {
  // primaryProvider/secondaryProvider são só os 2 primeiros slots de
  // providerOrder (nomes legados, mantidos por compatibilidade) -- não é
  // mais garantido que providerOrder tenha exatamente 2 entradas desde a
  // ativação do AgentRouter como 3º tier (agentrouter -> anthropic -> openai).
  assert.ok(Array.isArray(config.ai.providerOrder) && config.ai.providerOrder.length >= 1);
  assert.equal(config.ai.primaryProvider, config.ai.providerOrder[0] || null);
  assert.equal(config.ai.secondaryProvider, config.ai.providerOrder[1] || null);
});

test("config real: agentRouterApiKey NUNCA é carregado no processo do bot", () => {
  assert.equal("agentRouterApiKey" in config.ai, false);
});

test("config real: pricing.agentrouter não existe (custo permanece desconhecido/incompleto)", () => {
  assert.equal("agentrouter" in config.ai.pricing, false);
});

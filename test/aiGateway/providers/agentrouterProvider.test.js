const { test } = require("node:test");
const assert = require("node:assert/strict");
const { name, callProvider, normalize } = require("../../../lib/aiGateway/providers/agentrouterProvider");
const { SYSTEM_PROMPT } = require("../../../lib/aiGateway/promptBuilderEnglish");

test("name é 'agentrouter'", () => {
  assert.equal(name, "agentrouter");
});

test("callProvider: usa exclusivamente promptBuilderEnglish (system idêntico ao SYSTEM_PROMPT em inglês)", async () => {
  let received = null;
  const client = {
    runAgentRouterPrompt: async (args) => {
      received = args;
      return { text: "{}", usage: null, threadId: null, meta: {} };
    },
  };
  await callProvider(client, { symbol: "SOLUSDT" });
  assert.equal(received.system, SYSTEM_PROMPT);
  assert.ok(received.user.includes("SOLUSDT"));
});

test("callProvider: chama runAgentRouterPrompt exatamente uma vez, sem retry", async () => {
  let calls = 0;
  const client = {
    runAgentRouterPrompt: async () => {
      calls++;
      return { text: "{}", usage: null, threadId: null, meta: {} };
    },
  };
  await callProvider(client, {});
  assert.equal(calls, 1);
});

test("callProvider: repassa client.model quando presente; undefined quando ausente", async () => {
  let received = null;
  const clientWithModel = {
    model: "gpt-5.6-sol",
    runAgentRouterPrompt: async (args) => {
      received = args;
      return { text: "{}", usage: null, threadId: null, meta: {} };
    },
  };
  await callProvider(clientWithModel, {});
  assert.equal(received.model, "gpt-5.6-sol");

  const clientWithoutModel = {
    runAgentRouterPrompt: async (args) => {
      received = args;
      return { text: "{}", usage: null, threadId: null, meta: {} };
    },
  };
  await callProvider(clientWithoutModel, {});
  assert.equal(received.model, undefined);
});

test("callProvider: erro do client propaga sem try/catch mascarando (mesmo padrão dos outros providers)", async () => {
  const client = {
    runAgentRouterPrompt: async () => {
      const err = new Error("codex process exited with a non-zero code");
      err.code = "AGENTROUTER_EXIT_NONZERO";
      throw err;
    },
  };
  await assert.rejects(callProvider(client, {}), (e) => e.code === "AGENTROUTER_EXIT_NONZERO");
});

test("normalize: assessment válido é extraído corretamente de raw.text", () => {
  const raw = {
    text: JSON.stringify({
      bias: "bullish",
      strength: 70,
      confidence: 80,
      marketRegime: "TRENDING_BULL",
      signalQuality: "HIGH",
      riskLevel: "LOW",
      recommendation: "FAVOR_ENTRY",
      rationale: "Clear uptrend.",
      riskFlags: [],
    }),
    usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 30, reasoning_output_tokens: 0 },
    threadId: "thread-xyz",
    meta: { transport: "codex_cli", modelRequested: "gpt-5.6-sol", modelEffective: null, durationMs: 1234, exitCode: 0, pid: 9999, stderrByteLength: 0 },
  };
  const n = normalize(raw);

  assert.equal(n.bias, "bullish");
  assert.equal(n.strength, 70);
  assert.equal(n.parseError, null);
  assert.equal(n.rawResponseText, raw.text);
  assert.equal(n.threadId, "thread-xyz");
});

test("normalize: usage mapeado com os 5 campos, camelCase compatível + cacheWriteTokens", () => {
  const raw = {
    text: "{}",
    usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 5, output_tokens: 30, reasoning_output_tokens: 7 },
    threadId: null,
    meta: {},
  };
  const n = normalize(raw);
  assert.deepEqual(n.usage, {
    promptTokens: 100,
    completionTokens: 30,
    cachedTokens: 20,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
  });
});

test("normalize: usage ausente vira null (não objeto com tudo null)", () => {
  const n = normalize({ text: "{}", usage: null, threadId: null, meta: {} });
  assert.equal(n.usage, null);
});

test("normalize: usage malicioso (string, negativo, NaN, Infinity, float) -- cada campo vira null individualmente", () => {
  const raw = {
    text: "{}",
    usage: {
      input_tokens: "100",
      cached_input_tokens: -5,
      cache_write_input_tokens: NaN,
      output_tokens: Infinity,
      reasoning_output_tokens: 3.5,
    },
    threadId: null,
    meta: {},
  };
  const n = normalize(raw);
  assert.deepEqual(n.usage, {
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  });
});

test("normalize: JSON inválido em raw.text -> parseError explícito, NUNCA um assessment válido silencioso", () => {
  const n = normalize({ text: "isto não é json", usage: null, threadId: null, meta: {} });
  assert.equal(n.parseError, "invalid_json");
  assert.equal(n.bias, "neutral"); // default seguro, não um valor inventado como "válido"
});

test("normalize: schema parcial (enum inválido) -> parseError 'partial_schema'", () => {
  const n = normalize({
    text: JSON.stringify({ bias: "bullish", strength: 50, confidence: 50, marketRegime: "INVALIDO", signalQuality: "HIGH", riskLevel: "LOW", recommendation: "FAVOR_ENTRY", rationale: "x", riskFlags: [] }),
    usage: null,
    threadId: null,
    meta: {},
  });
  assert.equal(n.parseError, "partial_schema");
});

test("normalize: raw.text ausente/null -> parseError 'empty_response', não lança", () => {
  const n1 = normalize({ text: null, usage: null, threadId: null, meta: {} });
  assert.equal(n1.parseError, "empty_response");
  const n2 = normalize({});
  assert.equal(n2.parseError, "empty_response");
});

test("normalize: raw.text como OBJETO -> rawResponseText=null e parseError, nunca [object Object] processado", () => {
  const n = normalize({ text: { malicious: "payload" }, usage: null, threadId: null, meta: {} });
  assert.equal(n.rawResponseText, null);
  assert.equal(n.parseError, "empty_response");
});

test("normalize: threadId não-string (número/objeto) vira null", () => {
  assert.equal(normalize({ text: "{}", usage: null, threadId: 12345, meta: {} }).threadId, null);
  assert.equal(normalize({ text: "{}", usage: null, threadId: { id: "x" }, meta: {} }).threadId, null);
  assert.equal(normalize({ text: "{}", usage: null, threadId: "thread-ok", meta: {} }).threadId, "thread-ok");
});

test("normalize: sem model nenhum -> modelAttribution 'unknown'", () => {
  const n = normalize({ text: "{}", usage: null, threadId: null, meta: {} });
  assert.equal(n.model, null);
  assert.equal(n.modelRequested, null);
  assert.equal(n.modelAttribution, "unknown");
});

test("normalize: model como objeto ou string arbitrária (com espaço) vira null nos dois campos", () => {
  const nObj = normalize({ text: "{}", usage: null, threadId: null, meta: { modelRequested: { name: "gpt" }, modelEffective: { name: "gpt" } } });
  assert.equal(nObj.model, null);
  assert.equal(nObj.modelRequested, null);
  assert.equal(nObj.modelAttribution, "unknown");

  const nFreeText = normalize({ text: "{}", usage: null, threadId: null, meta: { modelRequested: "modelo qualquer com espaço", modelEffective: null } });
  assert.equal(nFreeText.modelRequested, null);
  assert.equal(nFreeText.modelAttribution, "unknown");
});

test("normalize: model/modelRequested/modelAttribution -- 3 estados corretos", () => {
  const semEffective = normalize({ text: "{}", usage: null, threadId: null, meta: { modelRequested: "gpt-5.6-sol", modelEffective: null } });
  assert.equal(semEffective.model, null);
  assert.equal(semEffective.modelRequested, "gpt-5.6-sol");
  assert.equal(semEffective.modelAttribution, "requested_unverified");

  const comEffective = normalize({ text: "{}", usage: null, threadId: null, meta: { modelRequested: "gpt-5.6-sol", modelEffective: "gpt-5.6-sol-2026-08-01" } });
  assert.equal(comEffective.model, "gpt-5.6-sol-2026-08-01");
  assert.equal(comEffective.modelAttribution, "effective");
});

test("normalize: meta nunca inclui pid, mesmo que raw.meta.pid exista", () => {
  const n = normalize({ text: "{}", usage: null, threadId: null, meta: { pid: 12345, transport: "codex_cli" } });
  assert.equal("pid" in n.meta, false);
  assert.equal(JSON.stringify(n).includes("12345"), false);
});

test("normalize: meta nunca inclui caminho temporário ou prompt, mesmo se presentes em raw", () => {
  const raw = {
    text: "{}",
    usage: null,
    threadId: null,
    meta: { transport: "codex_cli", workDir: "/tmp/crypto10-agentrouter-abc", prompt: "[SYSTEM INSTRUCTIONS]\nfake" },
  };
  const n = normalize(raw);
  assert.equal(JSON.stringify(n).includes("crypto10-agentrouter-abc"), false);
  assert.equal(JSON.stringify(n).includes("SYSTEM INSTRUCTIONS"), false);
});

test("normalize: meta sanitiza VALORES, não só nomes -- transport/invocationNote arbitrários viram null", () => {
  const n = normalize({
    text: "{}",
    usage: null,
    threadId: null,
    meta: { transport: "http_generic", invocationNote: "texto qualquer inventado" },
  });
  assert.equal(n.meta.transport, null);
  assert.equal(n.meta.invocationNote, null);
});

test("normalize: meta com strings/objetos arbitrários nos campos numéricos/booleanos não atravessa", () => {
  const n = normalize({
    text: "{}",
    usage: null,
    threadId: null,
    meta: {
      durationMs: "rápido",
      exitCode: "0",
      signal: "SIGKILL; rm -rf /",
      closeConfirmed: "sim",
      timedOut: 1,
      processError: "não",
      stdinError: {},
      eventCount: -3,
      stderrByteLength: 3.5,
    },
  });
  assert.equal(n.meta.durationMs, null);
  assert.equal(n.meta.exitCode, null);
  assert.equal(n.meta.signal, null);
  assert.equal(n.meta.closeConfirmed, null);
  assert.equal(n.meta.timedOut, null);
  assert.equal(n.meta.processError, null);
  assert.equal(n.meta.stdinError, null);
  assert.equal(n.meta.eventCount, null);
  assert.equal(n.meta.stderrByteLength, null);
});

test("normalize: meta preserva campos legítimos sanitizados corretamente", () => {
  const raw = {
    text: "{}",
    usage: null,
    threadId: null,
    meta: {
      transport: "codex_cli",
      invocationNote: "one Codex invocation per assessment, zero transport retries",
      durationMs: 4321,
      exitCode: 0,
      signal: null,
      closeConfirmed: true,
      timedOut: false,
      processError: false,
      stdinError: false,
      eventCount: 4,
      eventTypeCounts: { "thread.started": 1, "turn.completed": 1 },
      stderrByteLength: 0,
    },
  };
  const n = normalize(raw);
  assert.equal(n.meta.transport, "codex_cli");
  assert.equal(n.meta.invocationNote, "one Codex invocation per assessment, zero transport retries");
  assert.equal(n.meta.durationMs, 4321);
  assert.equal(n.meta.exitCode, 0);
  assert.equal(n.meta.closeConfirmed, true);
  assert.equal(n.meta.eventCount, 4);
  assert.deepEqual(n.meta.eventTypeCounts, { "thread.started": 1, "turn.completed": 1 });
});

test("normalize: eventTypeCounts com chave maliciosa ou valor inválido é filtrado, não propaga cru", () => {
  const n = normalize({
    text: "{}",
    usage: null,
    threadId: null,
    meta: {
      eventTypeCounts: {
        "chave com espaço e; comando": 999,
        valid_key: "não é número",
        another_valid: -1,
        good_one: 5,
      },
    },
  });
  assert.deepEqual(n.meta.eventTypeCounts, { good_one: 5 });
});

test("normalize: eventTypeCounts não-objeto vira null", () => {
  assert.equal(normalize({ text: "{}", usage: null, threadId: null, meta: { eventTypeCounts: "não é objeto" } }).meta.eventTypeCounts, null);
  assert.equal(normalize({ text: "{}", usage: null, threadId: null, meta: {} }).meta.eventTypeCounts, null);
});

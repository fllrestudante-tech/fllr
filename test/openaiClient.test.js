const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRequestBody, isReasoningFamily } = require("../lib/openaiClient");

test("isReasoningFamily: modelos gpt-5.x são família reasoning (não aceitam temperature customizada)", () => {
  assert.equal(isReasoningFamily("gpt-5.6-luna"), true);
  assert.equal(isReasoningFamily("gpt-5.6-sol"), true);
  assert.equal(isReasoningFamily("gpt-5"), true);
  assert.equal(isReasoningFamily("gpt-5.1-codex"), true);
});

test("isReasoningFamily: gpt-4o/gpt-4o-mini NÃO são família reasoning (aceitam temperature)", () => {
  assert.equal(isReasoningFamily("gpt-4o-mini"), false);
  assert.equal(isReasoningFamily("gpt-4o-mini-2024-07-18"), false);
  assert.equal(isReasoningFamily("gpt-4o"), false);
});

test("isReasoningFamily: model ausente/vazio não lança, devolve false", () => {
  assert.equal(isReasoningFamily(undefined), false);
  assert.equal(isReasoningFamily(""), false);
  assert.equal(isReasoningFamily(null), false);
});

test("buildRequestBody: gpt-5.6-luna usa reasoning_effort, NÃO envia temperature", () => {
  const body = buildRequestBody({ system: "sys", user: "usr", model: "gpt-5.6-luna", maxTokens: 2000, reasoningEffort: "none" });
  assert.equal(body.reasoning_effort, "none");
  assert.equal("temperature" in body, false);
  assert.equal(body.max_completion_tokens, 2000);
  assert.equal("max_tokens" in body, false); // max_tokens é rejeitado com 400 pelos modelos gpt-5.x -- nunca deve ser enviado
});

test("buildRequestBody: gpt-4o-mini usa temperature fixa, NÃO envia reasoning_effort", () => {
  const body = buildRequestBody({ system: "sys", user: "usr", model: "gpt-4o-mini", maxTokens: 500, reasoningEffort: "none" });
  assert.equal(body.temperature, 0.2);
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_completion_tokens, 500);
});

test("buildRequestBody: sempre monta messages com system+user na ordem certa e response_format json_object", () => {
  const body = buildRequestBody({ system: "REGRAS", user: "SNAPSHOT", model: "gpt-5.6-luna", maxTokens: 100, reasoningEffort: "none" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "REGRAS" },
    { role: "user", content: "SNAPSHOT" },
  ]);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

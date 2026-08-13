const test = require("node:test");
const assert = require("node:assert/strict");
const openaiProvider = require("../../lib/aiGateway/providers/openaiProvider");
const anthropicProvider = require("../../lib/aiGateway/providers/anthropicProvider");

const FULL_SCHEMA_PAYLOAD = {
  bias: "bullish",
  strength: 80,
  confidence: 75,
  marketRegime: "TRENDING_BULL",
  signalQuality: "HIGH",
  riskLevel: "LOW",
  recommendation: "FAVOR_ENTRY",
  rationale: "ok",
  riskFlags: [],
};

test("openaiProvider.normalize: extrai bias/strength/usage/model de choices[0].message.content", () => {
  const raw = {
    model: "gpt-4o-mini",
    choices: [{ message: { content: JSON.stringify(FULL_SCHEMA_PAYLOAD) } }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
  const n = openaiProvider.normalize(raw);
  assert.equal(n.bias, "bullish");
  assert.equal(n.strength, 80);
  assert.equal(n.marketRegime, "TRENDING_BULL");
  assert.equal(n.recommendation, "FAVOR_ENTRY");
  assert.equal(n.model, "gpt-4o-mini");
  assert.deepEqual(n.usage, { promptTokens: 120, completionTokens: 30 });
  assert.equal(n.parseError, null);
});

test("openaiProvider.normalize: resposta malformada não lança, degrada pra neutral", () => {
  const raw = { model: "gpt-4o-mini", choices: [{ message: { content: "não é json" } }] };
  const n = openaiProvider.normalize(raw);
  assert.equal(n.bias, "neutral");
  assert.equal(n.parseError, "invalid_json");
});

test("openaiProvider.normalize: resposta sem choices não lança", () => {
  const n = openaiProvider.normalize({});
  assert.equal(n.bias, "neutral");
  assert.equal(n.parseError, "empty_response");
  assert.equal(n.usage, null);
});

test("openaiProvider.callProvider: usa client injetado, não bate em axios/rede", async () => {
  let received = null;
  const fakeClient = {
    chatCompletion: async ({ system, user }) => {
      received = { system, user };
      return { choices: [{ message: { content: JSON.stringify({ bias: "neutral", strength: 10 }) } }] };
    },
  };
  const raw = await openaiProvider.callProvider(fakeClient, { symbol: "SOLUSDT" });
  assert.ok(received.user.includes("SOLUSDT"));
  assert.ok(received.system.includes("JSON"));
  assert.ok(raw.choices);
});

test("anthropicProvider.normalize: extrai bias/strength/usage/model de content[0].text", () => {
  const raw = {
    model: "claude-3-5-haiku-20241022",
    content: [{ type: "text", text: JSON.stringify({ bias: "bearish", strength: 65, rationale: "queda", riskFlags: ["baixa liquidez"] }) }],
    usage: { input_tokens: 200, output_tokens: 40 },
  };
  const n = anthropicProvider.normalize(raw);
  assert.equal(n.bias, "bearish");
  assert.equal(n.strength, 65);
  assert.equal(n.model, "claude-3-5-haiku-20241022");
  assert.deepEqual(n.usage, { promptTokens: 200, completionTokens: 40 });
  assert.deepEqual(n.riskFlags, ["baixa liquidez"]);
});

test("anthropicProvider.normalize: resposta sem content não lança", () => {
  const n = anthropicProvider.normalize({});
  assert.equal(n.bias, "neutral");
  assert.equal(n.parseError, "empty_response");
});

test("anthropicProvider.callProvider: usa client injetado, não bate em axios/rede", async () => {
  let received = null;
  const fakeClient = {
    createMessage: async ({ system, user }) => {
      received = { system, user };
      return { content: [{ text: JSON.stringify({ bias: "neutral", strength: 5 }) }] };
    },
  };
  const raw = await anthropicProvider.callProvider(fakeClient, { symbol: "SOLUSDT" });
  assert.ok(received.user.includes("SOLUSDT"));
  assert.ok(raw.content);
});

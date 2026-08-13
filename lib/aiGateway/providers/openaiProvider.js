const { buildPrompt } = require("../promptBuilder");
const { parseAssessment } = require("../assessmentSchema");

async function callProvider(client, context) {
  const { system, user } = buildPrompt(context);
  return client.chatCompletion({ system, user });
}

function normalize(rawResponse) {
  const text = rawResponse?.choices?.[0]?.message?.content || null;
  const assessment = parseAssessment(text);
  return {
    ...assessment,
    model: rawResponse?.model || null,
    usage: rawResponse?.usage
      ? { promptTokens: rawResponse.usage.prompt_tokens ?? null, completionTokens: rawResponse.usage.completion_tokens ?? null }
      : null,
    rawResponseText: text,
  };
}

module.exports = { name: "openai", callProvider, normalize };

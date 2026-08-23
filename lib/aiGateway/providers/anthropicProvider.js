const { buildPrompt } = require("../promptBuilder");
const { parseAssessment } = require("../assessmentSchema");

async function callProvider(client, context) {
  const { system, user } = buildPrompt(context);
  return client.createMessage({ system, user });
}

function normalize(rawResponse) {
  const text = rawResponse?.content?.[0]?.text || null;
  const assessment = parseAssessment(text);
  return {
    ...assessment,
    model: rawResponse?.model || null,
    usage: rawResponse?.usage
      ? { promptTokens: rawResponse.usage.input_tokens ?? null, completionTokens: rawResponse.usage.output_tokens ?? null }
      : null,
    rawResponseText: text,
  };
}

module.exports = { name: "anthropic", callProvider, normalize, buildPrompt };

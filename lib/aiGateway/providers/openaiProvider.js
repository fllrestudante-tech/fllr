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
    // cachedTokens/reasoningTokens vêm de prompt_tokens_details/
    // completion_tokens_details -- presentes nas respostas reais (gpt-4o-mini
    // e gpt-5.6-luna testados), mas tratados como opcionais (?? null) porque
    // nem toda resposta/versão de API garante esses sub-campos.
    usage: rawResponse?.usage
      ? {
          promptTokens: rawResponse.usage.prompt_tokens ?? null,
          completionTokens: rawResponse.usage.completion_tokens ?? null,
          cachedTokens: rawResponse.usage.prompt_tokens_details?.cached_tokens ?? null,
          reasoningTokens: rawResponse.usage.completion_tokens_details?.reasoning_tokens ?? null,
        }
      : null,
    rawResponseText: text,
  };
}

module.exports = { name: "openai", callProvider, normalize, buildPrompt };

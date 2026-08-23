const axios = require("axios");
const config = require("../config");
const { withRetry } = require("./httpRetry");

const BASE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

async function createMessage({ system, user, model, maxTokens }) {
  const apiKey = config.ai.anthropicApiKey;
  if (!apiKey) throw new Error("Anthropic: ANTHROPIC_API_KEY não configurada no .env");

  return withRetry(async () => {
    const { data } = await axios.post(
      BASE_URL,
      {
        model: model || config.ai.anthropicModel,
        max_tokens: maxTokens || config.ai.maxOutputTokens,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        timeout: config.ai.requestTimeoutMs,
      }
    );
    return data;
  });
}

module.exports = { createMessage, BASE_URL };

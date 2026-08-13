const axios = require("axios");
const config = require("../config");
const { withRetry } = require("./httpRetry");

const BASE_URL = "https://api.openai.com/v1/chat/completions";

// gpt-5.x (família reasoning, sucessora do o-series) não aceita temperature
// customizada -- só o default (1) -- e usa reasoning_effort em vez disso.
// Confirmado por teste real contra a API (2026-08-13): gpt-5.6-luna
// respondeu 400 "Unsupported value: 'temperature' does not support 0.2"
// quando testado. gpt-4o/gpt-4o-mini (família mais antiga) continuam
// aceitando temperature normalmente e não têm reasoning_effort. Heurística
// por prefixo -- não é uma lista oficial publicada pela OpenAI, é hipótese
// observada; se algum gpt-5.x futuro voltar a aceitar temperature, ajustar
// aqui (documentado, não travado pra sempre, mesma disciplina do pricing).
function isReasoningFamily(model) {
  return /^gpt-5/.test(model || "");
}

/**
 * Monta o corpo da requisição -- extraído em função pura só pra ser
 * testável sem precisar mockar axios/rede (mesmo padrão de
 * lib/aiGateway/costMetrics.js::estimateCostUsd). max_completion_tokens (não
 * max_tokens, deprecado e rejeitado pelos modelos gpt-5.x com 400) é usado
 * pra ambas as famílias -- confirmado que gpt-4o-mini também aceita.
 */
function buildRequestBody({ system, user, model, maxTokens, reasoningEffort }) {
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (isReasoningFamily(model)) {
    body.reasoning_effort = reasoningEffort;
  } else {
    body.temperature = 0.2;
  }
  return body;
}

async function chatCompletion({ system, user, model, maxTokens }) {
  const apiKey = config.ai.openaiApiKey;
  if (!apiKey) throw new Error("OpenAI: OPENAI_API_KEY não configurada no .env");

  const resolvedModel = model || config.ai.openaiModel;
  const body = buildRequestBody({
    system,
    user,
    model: resolvedModel,
    maxTokens: maxTokens || config.ai.maxOutputTokens,
    reasoningEffort: config.ai.openaiReasoningEffort,
  });

  return withRetry(async () => {
    const { data } = await axios.post(BASE_URL, body, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: config.ai.requestTimeoutMs,
    });
    return data;
  });
}

module.exports = { chatCompletion, buildRequestBody, isReasoningFamily, BASE_URL };

// Provider AgentRouter -- mesmo contrato {name, callProvider, normalize} de
// openaiProvider.js/anthropicProvider.js, com duas diferenças herdadas do
// transporte:
//   - usa promptBuilderEnglish.js (inglês, sanitizado), NUNCA promptBuilder.js
//     (português) -- decisão registrada desta integração.
//   - o "client" não é um HTTP client -- é lib/agentrouterClient.js
//     (runAgentRouterPrompt), injetável do mesmo jeito que openaiClient/
//     anthropicClient são hoje. `client.model`, se presente, é repassado
//     como model requisitado (fiação real com config.js fica pra quando
//     aiGateway.js for editado -- fora do escopo desta etapa).
//
// normalize() é sua PRÓPRIA fronteira de sanitização -- não confia
// cegamente na forma do `raw` que o client devolveu, mesmo sendo um módulo
// interno (não uma resposta HTTP de terceiro). Todo campo que vira log
// funcional (assessmentLog.js) passa por validação de tipo/faixa antes de
// sair daqui.
const { buildPrompt } = require("../promptBuilderEnglish");
const { parseAssessment } = require("../assessmentSchema");

const MODEL_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const SIGNAL_TOKEN_PATTERN = /^[A-Za-z0-9_]{1,20}$/;
const EVENT_TYPE_KEY_PATTERN = /^[A-Za-z0-9_.]{1,64}$/;
const KNOWN_TRANSPORT = "codex_cli";
const KNOWN_INVOCATION_NOTE = "one Codex invocation per assessment, zero transport retries";
const MAX_EVENT_TYPE_KEYS = 50;

function sanitizeModel(value) {
  return typeof value === "string" && MODEL_TOKEN_PATTERN.test(value) ? value : null;
}

function sanitizeNonNegativeInt(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function sanitizeNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizeExitCode(value) {
  return Number.isInteger(value) ? value : null;
}

function sanitizeBoolean(value) {
  return value === true || value === false ? value : null;
}

function sanitizeSignal(value) {
  return typeof value === "string" && SIGNAL_TOKEN_PATTERN.test(value) ? value : null;
}

function sanitizeTransport(value) {
  return value === KNOWN_TRANSPORT ? value : null;
}

function sanitizeInvocationNote(value) {
  return value === KNOWN_INVOCATION_NOTE ? value : null;
}

/** Cópia defensiva -- chave curta/técnica, valor inteiro não-negativo, teto de entradas. */
function sanitizeEventTypeCounts(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  let count = 0;
  for (const [key, val] of Object.entries(value)) {
    if (count >= MAX_EVENT_TYPE_KEYS) break;
    if (!EVENT_TYPE_KEY_PATTERN.test(key)) continue;
    const safeVal = sanitizeNonNegativeInt(val);
    if (safeVal === null) continue;
    result[key] = safeVal;
    count++;
  }
  return result;
}

async function callProvider(client, context) {
  const { system, user } = buildPrompt(context);
  // Sem retry aqui -- runAgentRouterPrompt já é zero-retry por design. O
  // fallback pra Anthropic/OpenAI acontece em lib/aiGateway/aiGateway.js,
  // não neste arquivo -- uma falha aqui simplesmente propaga (mesmo padrão
  // dos outros 2 providers).
  return client.runAgentRouterPrompt({ system, user, model: client.model ?? undefined });
}

function normalize(raw) {
  const rawResponseText = typeof raw?.text === "string" ? raw.text : null;
  const assessment = parseAssessment(rawResponseText);

  const usage = raw?.usage
    ? {
        promptTokens: sanitizeNonNegativeInt(raw.usage.input_tokens),
        completionTokens: sanitizeNonNegativeInt(raw.usage.output_tokens),
        cachedTokens: sanitizeNonNegativeInt(raw.usage.cached_input_tokens),
        cacheWriteTokens: sanitizeNonNegativeInt(raw.usage.cache_write_input_tokens),
        reasoningTokens: sanitizeNonNegativeInt(raw.usage.reasoning_output_tokens),
      }
    : null;

  const modelEffective = sanitizeModel(raw?.meta?.modelEffective);
  const modelRequested = sanitizeModel(raw?.meta?.modelRequested);
  let modelAttribution = "unknown";
  if (modelEffective) modelAttribution = "effective";
  else if (modelRequested) modelAttribution = "requested_unverified";

  const threadId = typeof raw?.threadId === "string" ? raw.threadId : null;

  return {
    ...assessment, // inclui parseError -- nunca mascarado; política de fallback (tratar como falha da tentativa) é do aiGateway.js, não deste provider
    model: modelEffective,
    modelRequested,
    modelAttribution,
    usage,
    rawResponseText,
    threadId,
    // Whitelist de NOMES *e* VALORES -- nunca pid, caminho temporário,
    // prompt ou stderr bruto; e nenhum valor arbitrário atravessa só por
    // estar sob um nome conhecido.
    meta: {
      transport: sanitizeTransport(raw?.meta?.transport),
      invocationNote: sanitizeInvocationNote(raw?.meta?.invocationNote),
      durationMs: sanitizeNonNegativeNumber(raw?.meta?.durationMs),
      exitCode: sanitizeExitCode(raw?.meta?.exitCode),
      signal: sanitizeSignal(raw?.meta?.signal),
      closeConfirmed: sanitizeBoolean(raw?.meta?.closeConfirmed),
      timedOut: sanitizeBoolean(raw?.meta?.timedOut),
      processError: sanitizeBoolean(raw?.meta?.processError),
      stdinError: sanitizeBoolean(raw?.meta?.stdinError),
      eventCount: sanitizeNonNegativeInt(raw?.meta?.eventCount),
      eventTypeCounts: sanitizeEventTypeCounts(raw?.meta?.eventTypeCounts),
      stderrByteLength: sanitizeNonNegativeInt(raw?.meta?.stderrByteLength),
    },
  };
}

module.exports = { name: "agentrouter", callProvider, normalize, buildPrompt };

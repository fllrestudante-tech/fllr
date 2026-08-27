// Orquestrador do AI Gateway -- Fase 1 (scaffold, não chamado pelo loop de
// trading). getAssessment(context) tenta os providers em providerOrder,
// sequencialmente (nunca fan-out simultâneo). Nunca lança -- chave ausente,
// erro de rede, timeout, JSON malformado ou falha de log sempre degradam
// pro próximo provider ou pra um BrainResult AI_UNAVAILABLE, sem exigir
// try/catch no call site.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../../config");
const { createBrainResult } = require("../brains/brainResult");
const { logAssessment } = require("./assessmentLog");
const openaiClient = require("../openaiClient");
const anthropicClient = require("../anthropicClient");
const agentrouterClient = require("../agentrouterClient");
const openaiProvider = require("./providers/openaiProvider");
const anthropicProvider = require("./providers/anthropicProvider");
const agentrouterProvider = require("./providers/agentrouterProvider");

const CONTEXT_KEYS = ["market", "structure", "liquidity", "fusion"];
const STATE_BY_BIAS = { bullish: "AI_BULLISH", bearish: "AI_BEARISH", neutral: "AI_NEUTRAL" };

// Checagem read-only e barata (fs.existsSync) -- NUNCA `codex doctor` (faz
// chamada de rede) a cada assessment. Só confirma "config/credencial
// externa presente", não que a autenticação é válida.
function isAgentRouterConfigured() {
  try {
    return fs.existsSync(path.join(os.homedir(), ".codex", "config.toml"));
  } catch {
    return false;
  }
}

// runAgentRouterPrompt não lê config.js diretamente por design -- a fiação
// de model/timeout/grace/comando acontece aqui.
const agentrouterClientWithConfig = {
  model: config.ai.agentRouterModel,
  runAgentRouterPrompt: (args) =>
    agentrouterClient.runAgentRouterPrompt({
      ...args,
      timeoutMs: config.ai.agentRouterTimeoutMs,
      gracefulShutdownMs: config.ai.agentRouterGracefulShutdownMs,
      codexCommand: config.ai.agentRouterCodexCommand,
    }),
};

const DEFAULT_PROVIDERS = {
  agentrouter: { provider: agentrouterProvider, client: agentrouterClientWithConfig, hasKey: () => isAgentRouterConfigured() },
  openai: { provider: openaiProvider, client: openaiClient, hasKey: () => !!config.ai.openaiApiKey },
  anthropic: { provider: anthropicProvider, client: anthropicClient, hasKey: () => !!config.ai.anthropicApiKey },
};

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

function hashContext(context) {
  return crypto.createHash("sha256").update(stableStringify(context || {})).digest("hex").slice(0, 16);
}

function computeContextCompleteness(context) {
  const present = CONTEXT_KEYS.filter((k) => context && context[k] != null).length;
  return Math.round((present / CONTEXT_KEYS.length) * 100);
}

function buildBrainResult({ normalized, provider, context, startedAt, requestId, contextHash }) {
  const reasons = [];
  if (normalized.rationale) reasons.push(normalized.rationale);
  for (const flag of normalized.riskFlags) reasons.push(`Risco sinalizado pela IA: ${flag}`);
  if (normalized.parseError) reasons.push(`Aviso: resposta da IA com problema de formato (${normalized.parseError})`);

  const missingEvidence = CONTEXT_KEYS.filter((k) => !(context && context[k] != null)).map(
    (k) => `${k} (Brain não fornecido no contexto)`
  );

  return createBrainResult({
    state: STATE_BY_BIAS[normalized.bias] || "AI_NEUTRAL",
    confidence: computeContextCompleteness(context),
    score: normalized.strength,
    reasons,
    evidence: [],
    missingEvidence,
    sourceDataTime: context?.fusion?.metadata?.sourceDataTime ?? context?.market?.metadata?.sourceDataTime ?? null,
    startedAt,
    dependsOn: CONTEXT_KEYS.filter((k) => context && context[k] != null),
    extra: {
      ai: {
        provider,
        model: normalized.model,
        modelRequested: normalized.modelRequested ?? null,
        modelAttribution: normalized.modelAttribution ?? "unknown",
        providerMeta: normalized.meta ?? null,
        aiConfidence: normalized.confidence ?? null,
        marketRegime: normalized.marketRegime ?? null,
        signalQuality: normalized.signalQuality ?? null,
        riskLevel: normalized.riskLevel ?? null,
        recommendation: normalized.recommendation ?? null,
        riskFlags: normalized.riskFlags,
        parseError: normalized.parseError,
        requestId,
        contextHash,
      },
    },
  });
}

/**
 * Preserva 100% a injeção legada de testes (opts.primaryProvider/
 * secondaryProvider, 2 slots) e adiciona opts.providerOrder (lista
 * completa, validada como array -- valor malformado não lança, só é
 * ignorado e cai pro próximo critério). Sem nenhum opt, usa
 * config.ai.providerOrder.
 */
function resolveProviderOrder(opts) {
  if (Array.isArray(opts.providerOrder)) return opts.providerOrder;
  if (opts.primaryProvider || opts.secondaryProvider) {
    return [opts.primaryProvider || config.ai.primaryProvider, opts.secondaryProvider || config.ai.secondaryProvider];
  }
  return config.ai.providerOrder;
}

/**
 * Só aceita códigos de erro no formato esperado (ex: AGENTROUTER_EXIT_NONZERO)
 * -- letras maiúsculas/dígitos/underscore, até 128 chars. Qualquer coisa
 * fora disso (minúsculo, espaço, símbolo, tamanho excessivo, não-string,
 * ausente) vira null. Nunca deixa passar texto livre disfarçado de código.
 */
function sanitizeErrorCode(err) {
  const code = err?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/.test(code) ? code : null;
}

/** Falha de log NUNCA pode alterar o BrainResult retornado -- protege throw síncrono e Promise rejeitada. */
function safeWrite(write, payload) {
  try {
    const maybePromise = write(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // ignora de propósito
  }
}

async function getAssessment(context, opts = {}) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const contextHash = hashContext(context);
  const providers = opts.providers || DEFAULT_PROVIDERS;
  const write = opts.logAssessment || logAssessment;

  // Fase 10 / Commit 4c2 -- gate do orçamento do AgentRouter, desligado por
  // padrão. opts.agentRouterBudgetEnabled é um override SÓ de teste
  // (mesmo padrão de opts.providerOrder/opts.primaryProvider); produção
  // real (index.js, sem opts) lê exclusivamente config.ai.agentRouterBudgetEnabled.
  const agentRouterGateEnabled = opts.agentRouterBudgetEnabled ?? config.ai.agentRouterBudgetEnabled;

  const rawOrder = resolveProviderOrder(opts);
  const order = (Array.isArray(rawOrder) ? rawOrder : []).filter(
    (name, i, arr) => name && providers[name] && arr.indexOf(name) === i
  );

  const attempted = [];
  const providerAttempts = [];
  const errorMessages = [];

  let winnerName = null;
  let winnerNormalized = null;
  let winnerPrompt = null;
  let winnerResult = null;

  for (const name of order) {
    const entry = providers[name];

    let hasKey;
    try {
      hasKey = !!entry.hasKey();
    } catch (err) {
      errorMessages.push(`${name}: hasKey() falhou -- ${err.message}`);
      continue;
    }
    if (!hasKey) {
      errorMessages.push(`${name}: sem API key configurada`);
      continue;
    }

    attempted.push(name);
    const attemptStartedAt = Date.now();

    // Só true pra "agentrouter" com o gate ligado -- pra QUALQUER outro
    // provider, ou pro próprio agentrouter com o gate desligado, este
    // bloco inteiro (identidade/ledger/policy/wrapper) nunca é construído
    // nem os módulos pesados (SQLite/policy/wrapper) chegam a ser
    // `require()`ados -- isolamento estrutural, não só "não usado".
    const isAgentRouterGated = name === "agentrouter" && agentRouterGateEnabled;
    let effectiveClient = entry.client;
    let gateDbProvider = null;
    let gateIdentity = null; // {taskClass, assessmentKey, attemptId} -- só setado se a identidade foi construída com sucesso

    try {
      if (isAgentRouterGated) {
        // opts.agentRouterGate é um override SÓ de teste (mesmo padrão de
        // opts.providers) -- {dbProvider, policy, createBudgetedClient,
        // realRunAgentRouterPrompt, nowFn, randomUUIDFn}. Cada `require()`
        // dos módulos pesados (SQLite/policy/wrapper) só acontece se o
        // teste NÃO tiver injetado o override correspondente -- um teste
        // que injeta os 4 nunca aciona nenhum desses `require()`s, prova
        // adicional (além do gate desligado) de que nada aqui é carregado
        // "só por garantia". Produção real (index.js) nunca passa
        // opts.agentRouterGate -- usa sempre os 4 requires reais abaixo.
        const gateOverrides = opts.agentRouterGate || {};
        const { buildGatedAgentRouterInvocation } = require("./agentRouterGate");

        gateDbProvider = gateOverrides.dbProvider || require("./agentRouterBudgetedClient").createLazyDbProvider();
        const policy = gateOverrides.policy || require("./agentRouterBudgetPolicy").createAgentRouterBudgetPolicy();
        const createBudgetedClient = gateOverrides.createBudgetedClient || require("./agentRouterBudgetedClient").createBudgetedAgentRouterClient;
        const realRunAgentRouterPrompt = gateOverrides.realRunAgentRouterPrompt || ((args) => require("../agentrouterClient").runAgentRouterPrompt(args));

        const built = buildGatedAgentRouterInvocation({
          context,
          assessmentMeta: opts.assessmentMeta,
          baseClient: entry.client,
          dbProvider: gateDbProvider,
          policy,
          createBudgetedClient,
          realRunAgentRouterPrompt,
          timeoutMs: config.ai.agentRouterTimeoutMs,
          gracefulShutdownMs: config.ai.agentRouterGracefulShutdownMs,
          codexCommand: config.ai.agentRouterCodexCommand,
          ...(gateOverrides.nowFn ? { nowFn: gateOverrides.nowFn } : {}),
          ...(gateOverrides.randomUUIDFn ? { randomUUIDFn: gateOverrides.randomUUIDFn } : {}),
        });
        effectiveClient = built.client;
        gateIdentity = { taskClass: built.taskClass, assessmentKey: built.assessmentKey, attemptId: built.attemptId };
      }

      // buildPrompt() DENTRO do try -- se lançar, vira uma tentativa "error"
      // como qualquer outra, e o loop segue pro próximo provider.
      const promptForLog = typeof entry.provider.buildPrompt === "function" ? entry.provider.buildPrompt(context) : null;
      const raw = await entry.provider.callProvider(effectiveClient, context);
      const normalized = entry.provider.normalize(raw, context);
      const attemptLatencyMs = Date.now() - attemptStartedAt;

      if (normalized.parseError) {
        // Resposta chegou (sem erro de transporte), mas não é um assessment
        // válido -- NUNCA sucesso silencioso. Registrado em providerAttempts
        // (preserva usage/model pra custo) e segue pro próximo provider,
        // igual um erro de transporte faria.
        providerAttempts.push({
          provider: name,
          status: "parse_error",
          latencyMs: attemptLatencyMs,
          model: normalized.model ?? null,
          modelRequested: normalized.modelRequested ?? null,
          modelAttribution: normalized.modelAttribution ?? "unknown",
          usage: normalized.usage ?? null,
          parseError: normalized.parseError,
          rawResponseText: normalized.rawResponseText ?? null,
          error: null,
          ...(gateIdentity || {}),
        });
        errorMessages.push(`${name}: parseError=${normalized.parseError}`);
        continue;
      }

      // Só declara sucesso DEPOIS de buildBrainResult não lançar -- se
      // lançar, cai no catch abaixo como UMA ÚNICA entrada "error", nunca
      // "success" + "error" pro mesmo provider. Nenhuma variável de
      // vencedor é tocada antes desta linha.
      const result = buildBrainResult({ normalized, provider: name, context, startedAt, requestId, contextHash });

      providerAttempts.push({
        provider: name,
        status: "success",
        latencyMs: attemptLatencyMs,
        model: normalized.model ?? null,
        modelRequested: normalized.modelRequested ?? null,
        modelAttribution: normalized.modelAttribution ?? "unknown",
        usage: normalized.usage ?? null,
        parseError: null,
        error: null,
        ...(gateIdentity || {}),
      });

      winnerName = name;
      winnerNormalized = normalized;
      winnerPrompt = promptForLog;
      winnerResult = result;
      break;
    } catch (err) {
      const attemptLatencyMs = Date.now() - attemptStartedAt;

      if (isAgentRouterGated && err?.fallbackAllowed !== true) {
        // Caminho FATAL do gate -- qualquer erro de identidade (trigger/
        // candle/fingerprint/assessmentKey/attemptId) ou do
        // ledger/policy/wrapper cujo fallbackAllowed não seja EXATAMENTE
        // true. NUNCA lê err.message/stack -- sanitizeAgentRouterFatalError
        // só usa err.code contra uma allowlist fechada (ver
        // agentRouterGate.js). O loop PARA aqui (break, não continue):
        // nenhum provider seguinte é tentado.
        const { sanitizeAgentRouterFatalError } = require("./agentRouterGate");
        const { errorCode, message } = sanitizeAgentRouterFatalError(err);
        const identity = gateIdentity || err?.partialAgentRouterIdentity || { taskClass: null, assessmentKey: null, attemptId: null };
        providerAttempts.push({
          provider: name,
          status: "agentrouter_fatal",
          latencyMs: attemptLatencyMs,
          model: null,
          modelRequested: typeof entry.client?.model === "string" ? entry.client.model : null,
          modelAttribution: "unknown",
          usage: null,
          parseError: null,
          errorCode,
          error: message,
          taskClass: identity.taskClass,
          assessmentKey: identity.assessmentKey,
          attemptId: identity.attemptId,
        });
        errorMessages.push(`${name}: ${message}`);
        break; // fechamento do DB acontece no finally abaixo, mesmo com break
      }

      // Fallback permitido do gate (isAgentRouterGated && fallbackAllowed===true,
      // ex.: GLOBAL_BUDGET_EXHAUSTED) -- reaproveita o MESMO sanitizador do
      // caminho fatal (sanitizeAgentRouterFatalError, ver agentRouterGate.js)
      // pra nunca persistir err.message/stack brutos aqui também, sem
      // duplicar uma segunda tabela de mensagens. Só afeta este caso
      // específico -- qualquer outro erro (provider não gateado, ou
      // agentrouter com a flag desligada) mantém sanitizeErrorCode(err) e
      // err.message exatamente como sempre foi.
      let attemptErrorCode = sanitizeErrorCode(err);
      let attemptErrorMessage = err.message;
      if (isAgentRouterGated && err?.fallbackAllowed === true) {
        const { sanitizeAgentRouterFatalError } = require("./agentRouterGate");
        const sanitized = sanitizeAgentRouterFatalError(err);
        attemptErrorCode = sanitized.errorCode;
        attemptErrorMessage = sanitized.message;
      }

      providerAttempts.push({
        provider: name,
        status: "error",
        latencyMs: attemptLatencyMs,
        model: null,
        // Não é model efetivo (a chamada falhou), mas é informação útil da
        // tentativa quando o client injetado carrega um model requisitado
        // (ex: agentrouterClientWithConfig.model).
        modelRequested: typeof entry.client?.model === "string" ? entry.client.model : null,
        modelAttribution: "unknown",
        usage: null,
        parseError: null,
        errorCode: attemptErrorCode,
        error: attemptErrorMessage,
        ...(gateIdentity || {}),
      });
      errorMessages.push(`${name}: ${attemptErrorMessage}`);
    } finally {
      if (gateDbProvider) gateDbProvider.closeDb();
    }
  }

  const finalResult =
    winnerResult ||
    createBrainResult({
      state: "AI_UNAVAILABLE",
      confidence: 0,
      score: 0,
      reasons: errorMessages.length ? errorMessages : ["Nenhum provider de IA configurado (AI_PROVIDER_ORDER/AI_PRIMARY_PROVIDER/AI_SECONDARY_PROVIDER)"],
      evidence: [],
      missingEvidence: ["AgentRouter", "OpenAI API", "Anthropic API"],
      sourceDataTime: null,
      startedAt,
      dependsOn: [],
      extra: { ai: { provider: null, model: null, modelRequested: null, modelAttribution: "unknown", providerMeta: null, requestId, contextHash } },
    });

  // UM único registro por requestId -- sempre, sucesso ou falha total.
  safeWrite(write, {
    requestId,
    contextHash,
    symbol: context?.symbol ?? null,
    interval: context?.interval ?? null,
    provider: winnerName,
    model: winnerNormalized?.model ?? null,
    modelRequested: winnerNormalized?.modelRequested ?? null,
    modelAttribution: winnerNormalized?.modelAttribution ?? "unknown",
    providerMeta: winnerNormalized?.meta ?? null,
    attempted: [...attempted],
    status: winnerName ? "success" : attempted.length ? "provider_error" : "no_provider_available",
    latencyMs: Date.now() - startedAt,
    usage: winnerNormalized?.usage ?? null,
    prompt: winnerPrompt,
    rawResponseText: winnerNormalized?.rawResponseText ?? null,
    assessment: {
      state: finalResult.state,
      confidence: finalResult.confidence,
      score: finalResult.score,
      aiConfidence: winnerNormalized?.confidence ?? null,
      marketRegime: winnerNormalized?.marketRegime ?? null,
      signalQuality: winnerNormalized?.signalQuality ?? null,
      riskLevel: winnerNormalized?.riskLevel ?? null,
      recommendation: winnerNormalized?.recommendation ?? null,
      riskFlags: winnerNormalized?.riskFlags ?? [],
      rationale: winnerNormalized?.rationale ?? null,
      parseError: winnerNormalized?.parseError ?? null,
    },
    error: errorMessages.length ? errorMessages.join(" | ") : null,
    providerAttempts: [...providerAttempts],
  });

  return finalResult;
}

module.exports = { getAssessment, hashContext, computeContextCompleteness, buildBrainResult, DEFAULT_PROVIDERS, isAgentRouterConfigured, sanitizeErrorCode };

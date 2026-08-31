// Transporte Telegram -- OUTBOUND-ONLY por construção: este arquivo nunca
// chama getUpdates/setWebhook, nunca registra um handler de comando, nunca
// lê nada vindo do Telegram. O único método além de sendMessage usado em
// TODO o projeto é getMe (lib/connectivityManager.js), como health check
// puro (throttle próprio, ver aquele arquivo) -- nunca como fonte de
// entrada/estado. Todo texto que sai por aqui passa por UM pipeline central
// de sanitização (sanitizeAlertText) antes de qualquer axios.post -- nenhum
// caminho de código monta a URL/body de sendMessage fora de
// sendTelegramAlert().
const crypto = require("crypto");
const axios = require("axios");
const config = require("../config");
const logger = require("./logger");

// =====================================================================
// Sanitização central -- controle de caracteres, redação de segredo,
// limite de tamanho. Roda incondicionalmente pra QUALQUER texto que
// chegue em sendTelegramAlert, nunca opcional.
// =====================================================================

// Bem abaixo do limite real do Telegram (4096 code units UTF-16 pro corpo
// de sendMessage) -- margem de segurança, nunca depende de contar exato.
const MAX_MESSAGE_LENGTH = 3500;
const TRUNCATION_MARKER = "\n… [truncado]";

// Remove C0 (exceto \n=0x0A e \t=0x09, formatação legítima de alerta
// multi-linha) e C1 -- nunca deixa passar algo que possa confundir o
// cliente Telegram ou esconder conteúdo fora da visão normal.
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Defesa em profundidade -- o payload de alerta hoje não deveria carregar
// nada disso, mas nunca confia nisso silenciosamente. Cobre: bot token do
// Telegram embutido numa URL (o próprio padrão que este arquivo usa pra
// montar a URL de envio), header Authorization colado cru de um erro
// copiado, padrão genérico chave=valor (api_key/token/secret/signature/
// senha/password), e o mesmo conjunto como parâmetro de query string.
const SECRET_PATTERNS = [
  { pattern: /\bbot\d{6,}:[A-Za-z0-9_-]{20,}/gi, replacement: "bot[REDACTED]" },
  { pattern: /\bAuthorization\s*:\s*(?:Bearer\s+)?\S+/gi, replacement: "Authorization: [REDACTED]" },
  { pattern: /\b(api[_-]?key|access[_-]?token|secret|signature|password|senha|token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{6,}["']?/gi, replacement: "$1=[REDACTED]" },
  { pattern: /([?&](?:token|key|secret|signature|api_key|access_token)=)[^&\s]+/gi, replacement: "$1[REDACTED]" },
];

function stripControlChars(text) {
  return text.replace(CONTROL_CHAR_PATTERN, "");
}

function redactSecrets(text) {
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function truncateSafe(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Pipeline único -- ordem importa: remove controle ANTES de redigir
 * segredo (um caractere de controle no meio de um token não pode escapar
 * do regex de redação), trunca por ÚLTIMO (nunca corta no meio de uma
 * redação já aplicada).
 */
function sanitizeAlertText(rawText) {
  const asString = typeof rawText === "string" ? rawText : String(rawText ?? "");
  return truncateSafe(redactSecrets(stripControlChars(asString)));
}

// =====================================================================
// Alerta estruturado -- allowlist fechada de campos, nunca texto livre
// arbitrário. Uso opcional (callers existentes continuam mandando string
// livre em sendTelegramAlert, que passa pelo MESMO pipeline de
// sanitização) -- este é o caminho recomendado pra alertas NOVOS.
// =====================================================================

const STRUCTURED_ALERT_ALLOWED_FIELDS = new Set(["severity", "source", "message", "count", "windowMinutes", "emoji"]);

class UnrecognizedAlertFieldError extends Error {
  constructor(field) {
    super(`Campo de alerta estruturado não reconhecido: "${field}" -- allowlist: ${[...STRUCTURED_ALERT_ALLOWED_FIELDS].join(", ")}`);
    this.name = this.constructor.name;
    this.code = "UNRECOGNIZED_ALERT_FIELD";
  }
}

function buildStructuredAlertText(fields = {}) {
  for (const key of Object.keys(fields)) {
    if (!STRUCTURED_ALERT_ALLOWED_FIELDS.has(key)) throw new UnrecognizedAlertFieldError(key);
  }
  const { severity, source, message, count, windowMinutes, emoji } = fields;
  const prefix = emoji ? `${emoji} ` : "";
  const tag = severity ? `[${severity}] ` : "";
  const src = source ? `[${source}] ` : "";
  const countSuffix = count != null ? ` -- ${count} vez(es)${windowMinutes != null ? ` nos últimos ${windowMinutes}min` : ""}` : "";
  return `${prefix}${tag}${src}${message || ""}${countSuffix}`.replace(/[ \t]+/g, " ").trim();
}

// =====================================================================
// Deduplicação (fingerprint do texto JÁ sanitizado + janela deslizante) e
// rate limit (janela global, independente de conteúdo) -- estado de
// processo (mesmo padrão "singleton com memória" já usado em
// lib/aiGateway/agentRouterGate.js pra activeRun). Ambos são reservados
// ANTES da chamada de rede (limitam TENTATIVA, não só sucesso -- protege
// mesmo se o Telegram estiver respondendo devagar/com erro).
// =====================================================================

const DEDUP_WINDOW_MS_DEFAULT = 5 * 60 * 1000;
const RATE_LIMIT_MAX_PER_WINDOW_DEFAULT = 10;
const RATE_LIMIT_WINDOW_MS_DEFAULT = 5 * 60 * 1000;
const MAX_QUEUE_SIZE_DEFAULT = 20;
const SEND_TIMEOUT_MS_DEFAULT = 10_000;

let dedupLastSentAtMs = new Map(); // fingerprint -> timestamp do último envio reservado
let rateLimitTimestamps = []; // timestamps (ms) de tentativas dentro da janela atual
let inFlightCount = 0; // envios reservados, ainda não finalizados (sucesso/falha)

function fingerprintOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function pruneOldTimestamps(timestamps, now, windowMs) {
  while (timestamps.length && now - timestamps[0] >= windowMs) timestamps.shift();
}

// Achado na re-verificação pós-implementação (round de auditoria do
// coordenador): dedupLastSentAtMs (Map) nunca removia entradas antigas --
// cada fingerprint DISTINTO visto na vida do processo ficava pra sempre,
// crescimento sem limite num processo de longa duração com muitas mensagens
// distintas ao longo do tempo (diferente de rateLimitTimestamps, que já era
// podado a cada chamada). Varredura O(n) a cada chamada, custo desprezível
// dado o volume de alertas esperado -- mantém só fingerprints ainda dentro
// da janela de dedup relevante à chamada atual.
function pruneStaleDedupEntries(map, now, windowMs) {
  for (const [fingerprint, ts] of map) {
    if (now - ts >= windowMs) map.delete(fingerprint);
  }
}

/** Só pra teste -- reseta todo o estado de processo (dedup/rate-limit/fila) entre casos, nunca chamado em produção. */
function __resetAlertsRuntimeStateForTests() {
  dedupLastSentAtMs = new Map();
  rateLimitTimestamps = [];
  inFlightCount = 0;
}

// =====================================================================
// Métricas locais sanitizadas -- reaproveita logger.logAlert (mesma trilha
// JSONL já usada por transições de health/alerta, config.paths.alertsLog),
// nunca um arquivo/tabela novo. Só outcome/fingerprint/tamanho/código de
// erro restrito -- NUNCA o texto do alerta em si nem detalhe bruto de erro.
// =====================================================================

function recordAlertOutcome(outcome, { fingerprint, length, errorCode } = {}) {
  try {
    logger.logAlert({ event: "telegram_alert_outcome", outcome, fingerprint, length, ...(errorCode ? { errorCode } : {}) });
  } catch {
    // Métrica é só-observação -- uma falha ao gravar NUNCA pode impedir o
    // envio/retorno do alerta em si (mesma disciplina de fail-open abaixo).
  }
}

/**
 * Nunca lê err.message/err.stack/err.config (poderia carregar a URL com o
 * bot token embutido, ou corpo de resposta) -- só um código de baixa
 * cardinalidade (mesmo padrão de allowlist-only já usado em
 * lib/aiGateway/agentRouterGate.js::sanitizeAgentRouterFatalError).
 */
function sanitizeAxiosErrorCode(err) {
  if (err && typeof err === "object") {
    if (typeof err.code === "string" && err.code) return err.code; // ECONNABORTED, ENOTFOUND, ECONNRESET, ...
    if (err.response && typeof err.response.status === "number") return `http_${err.response.status}`;
  }
  return "unknown_error";
}

// =====================================================================
// Envio -- único ponto de saída pro Telegram. Nunca lança: qualquer falha
// (config ausente, dedup, rate limit, fila cheia, erro de rede/timeout)
// resolve com {sent:false, reason}, preservando fail-open pra operação do
// bot mesmo em chamadores que não envolvem a chamada em try/catch.
// =====================================================================

async function sendTelegramAlert(text, opts = {}) {
  const botToken = opts.botToken ?? config.alerts.telegramBotToken;
  const chatId = opts.chatId ?? config.alerts.telegramChatId;
  const post = opts.post ?? axios.post;
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS_DEFAULT;
  const dedupWindowMs = opts.dedupWindowMs ?? DEDUP_WINDOW_MS_DEFAULT;
  const rateLimitMaxPerWindow = opts.rateLimitMaxPerWindow ?? RATE_LIMIT_MAX_PER_WINDOW_DEFAULT;
  const rateLimitWindowMs = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS_DEFAULT;
  const maxQueueSize = opts.maxQueueSize ?? MAX_QUEUE_SIZE_DEFAULT;

  const sanitized = sanitizeAlertText(text);

  if (!botToken || !chatId) {
    console.warn("⚠️  Alerta não enviado (TELEGRAM_ALERT_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID ausentes):", sanitized);
    return { sent: false, reason: "not_configured" };
  }

  const fingerprint = fingerprintOf(sanitized);
  const length = sanitized.length;

  pruneStaleDedupEntries(dedupLastSentAtMs, now, dedupWindowMs);
  const lastSentAt = dedupLastSentAtMs.get(fingerprint);
  if (lastSentAt != null && now - lastSentAt < dedupWindowMs) {
    recordAlertOutcome("deduplicated", { fingerprint, length });
    return { sent: false, reason: "deduplicated" };
  }

  pruneOldTimestamps(rateLimitTimestamps, now, rateLimitWindowMs);
  if (rateLimitTimestamps.length >= rateLimitMaxPerWindow) {
    recordAlertOutcome("rate_limited", { fingerprint, length });
    return { sent: false, reason: "rate_limited" };
  }

  if (inFlightCount >= maxQueueSize) {
    recordAlertOutcome("queue_full", { fingerprint, length });
    return { sent: false, reason: "queue_full" };
  }

  // Reserva ANTES da chamada de rede -- limita a taxa de TENTATIVA, não só
  // de sucesso.
  dedupLastSentAtMs.set(fingerprint, now);
  rateLimitTimestamps.push(now);
  inFlightCount += 1;

  try {
    await post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: sanitized }, { timeout: timeoutMs });
    recordAlertOutcome("sent", { fingerprint, length });
    return { sent: true };
  } catch (err) {
    const errorCode = sanitizeAxiosErrorCode(err);
    recordAlertOutcome("failed", { fingerprint, length, errorCode });
    return { sent: false, reason: "send_failed", errorCode };
  } finally {
    inFlightCount -= 1;
  }
}

const STATUS_EMOJI = { ok: "✅", degraded: "⚠️", down: "🔴", not_implemented: "⬜", stopped: "⏹️", disabled: "⬜", MANUAL: "🧑", ERROR: "🔴", STARTING: "🟡", UNKNOWN: "❔" };

/**
 * Só dispara em transições de status (ok->down, down->ok, etc.) — nunca a
 * cada ciclo, senão vira spam enquanto o problema persiste.
 */
async function alertOnTransitions(transitions, sender = sendTelegramAlert) {
  for (const t of transitions) {
    const emoji = STATUS_EMOJI[t.to] || "❔";
    await sender(`${emoji} [${t.name}] ${t.from} → ${t.to}`);
  }
}

/** Só pra teste -- expõe o TAMANHO atual do estado de processo (nunca o conteúdo), pra provar que fila/rate-limit/dedup não crescem sem limite. */
function __getAlertsRuntimeStateSizeForTests() {
  return { dedupMapSize: dedupLastSentAtMs.size, rateLimitQueueLength: rateLimitTimestamps.length, inFlightCount };
}

module.exports = {
  sendTelegramAlert,
  alertOnTransitions,
  sanitizeAlertText,
  buildStructuredAlertText,
  UnrecognizedAlertFieldError,
  STRUCTURED_ALERT_ALLOWED_FIELDS,
  recordAlertOutcome,
  __resetAlertsRuntimeStateForTests,
  __getAlertsRuntimeStateSizeForTests,
};

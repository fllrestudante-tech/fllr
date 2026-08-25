// Gerador puro da assessmentKey -- identidade determinística de uma
// avaliação LÓGICA do AgentRouter, estável entre reinícios/crashes (Fase 10
// / Commit 4a). NÃO reutiliza aiGateway.js::hashContext() -- auditoria
// registrada no relatório do commit encontrou 3 campos voláteis dentro do
// context hoje produzido por contextSnapshot.js:
//   - snapshotAt: new Date(now).toISOString() -- horário de execução, muda
//     em toda chamada mesmo pra uma avaliação logicamente idêntica;
//   - position.holdMs: Date.now() - botState.openedAt -- muda continuamente
//     enquanto uma posição está aberta;
//   - riskState.circuitBreakerRemainingMs: contagem regressiva -- muda
//     continuamente enquanto o circuit breaker está ativo.
// hashContext() hasheia o context INTEIRO (stableStringify canonicaliza só
// a ORDEM das chaves, não remove esses campos voláteis) -- logo, duas
// chamadas para a MESMA avaliação lógica (mesmo candle, mesmo trigger)
// produziriam contextHash DIFERENTE só por causa do relógio. Por isso este
// módulo aceita um payload EXPLÍCITO e restrito, nunca o context bruto.
//
// Também não há hoje, em contextSnapshot.js, nenhum campo de timestamp de
// abertura/fechamento de candle que sobreviva ao objeto final (fusion não
// carrega `metadata.sourceDataTime` na forma como contextSnapshot.js monta
// hoje) -- por isso candleTimestampMs é um parâmetro EXPLÍCITO deste
// gerador; o wiring real (de onde esse valor vem no pipeline de produção)
// fica para o Commit 4c, fora do escopo deste commit.
//
// Todo texto operacional deste módulo (mensagens/códigos de erro) está em
// inglês -- pode um dia atravessar logs/metadata perto da fronteira do
// AgentRouter. Comentários seguem em português.
const crypto = require("crypto");

const ASSESSMENT_KEY_VERSION = "v1";
const KEY_PREFIX = "ar-ak";
const QUANT_FINGERPRINT_VERSION = "v1";
const QUANT_FINGERPRINT_PREFIX = "qf";

// Mesma forma de TOKEN_ID_PATTERN em lib/aiGateway/agentRouterLedger.js --
// duplicada aqui de propósito (este módulo não pode depender do ledger,
// fora do escopo autorizado do Commit 4a) para validar, de forma
// defensiva, que a chave final SEMPRE caberia como idempotencyKey/
// correlationId quando o wiring do Commit 4c a usar.
const LEDGER_TOKEN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

// Token curto/técnico -- símbolo, intervalo, trigger, taskClass, versões,
// regime, lado de posição. Nunca frase, nunca texto livre (o que já
// rejeita, por construção, qualquer conteúdo de Telegram/prompt/segredo
// que alguém tente passar por engano -- espaço/acento/pontuação de frase
// já falham no regex).
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

// quantFingerprint e' "qf:v1:" + 64 hex (SHA-256 completo) = 70 chars --
// excede SHORT_TOKEN_PATTERN (max 64) de proposito, entao usa seu proprio
// padrao (mesmo charset, limite maior, mesmo espirito: token tecnico curto,
// nunca frase).
const QUANT_FINGERPRINT_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

// Allowlist REAL de signal.analyze() (lib/signal.js) -- "wait" (default e
// early-return sem candles), "buy", "sell". Nunca aceita texto arbitrario
// aqui: um valor fora desses tres e' quase certamente um erro de
// integracao (ou, na pior hipotese, uma tentativa de injetar algo).
const QUANT_SIGNAL_ALLOWLIST = new Set(["wait", "buy", "sell"]);

class AssessmentKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class InvalidAssessmentKeyInputError extends AssessmentKeyError {
  constructor(field, detail) {
    super("INVALID_ASSESSMENT_KEY_INPUT", `Invalid assessmentKey input field "${field}": ${detail}`);
    this.field = field;
  }
}

class InvalidAssessmentKeyOutputError extends AssessmentKeyError {
  constructor(key) {
    super("INVALID_ASSESSMENT_KEY_OUTPUT", "Computed assessmentKey failed the defensive output pattern check");
    this.key = key;
  }
}

class UnrecognizedAssessmentKeyFieldError extends AssessmentKeyError {
  constructor(field) {
    super(
      "UNRECOGNIZED_ASSESSMENT_KEY_FIELD",
      `computeAssessmentKey() does not accept field "${field}" -- only the fixed set of stable, non-sensitive identity fields is allowed (allowlist, never ignored silently)`
    );
    this.field = field;
  }
}

class InvalidAttemptIdError extends AssessmentKeyError {
  constructor(value) {
    super("INVALID_ATTEMPT_ID", `randomUUIDFn() returned an invalid value (expected a UUID string): ${JSON.stringify(value)}`);
  }
}

class InvalidQuantFingerprintInputError extends AssessmentKeyError {
  constructor(field) {
    super("INVALID_QUANT_FINGERPRINT_INPUT", `Invalid quant fingerprint input field "${field}": must be a finite number`);
    this.field = field;
  }
}

class InvalidQuantSignalError extends AssessmentKeyError {
  constructor(value) {
    super("INVALID_QUANT_SIGNAL", `Invalid quant.signal value: expected one of wait|buy|sell, got ${JSON.stringify(value)}`);
    this.value = value;
  }
}

// Allowlist ESTRITA -- unico conjunto de campos que computeAssessmentKey()
// aceita. Qualquer chave fora daqui (attemptId, createdAtMs, snapshotAt,
// prompt, telegramText, apiKey, ou qualquer outra) lanca
// UnrecognizedAssessmentKeyFieldError -- nunca e' silenciosamente
// ignorada. Isso fecha a lacuna de contrato: antes, um campo extra passado
// por engano nao alterava a chave nem o resultado, mascarando o erro de
// integracao; agora, o erro fica visivel imediatamente no boundary.
const ALLOWED_INPUT_FIELDS = new Set([
  "symbol",
  "interval",
  "candleTimestampMs",
  "triggerReason",
  "taskClass",
  "promptVersion",
  "schemaVersion",
  "regime",
  "positionSide",
  "quantFingerprint",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertShortToken(value, fieldName) {
  if (typeof value !== "string" || !SHORT_TOKEN_PATTERN.test(value)) {
    throw new InvalidAssessmentKeyInputError(fieldName, "must be a short technical token (letters/digits/._:- only, max 64 chars, no free text)");
  }
  return value;
}

function assertOptionalShortToken(value, fieldName) {
  if (value === null || value === undefined) return null;
  return assertShortToken(value, fieldName);
}

function assertSafeNonNegativeMs(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidAssessmentKeyInputError(fieldName, "must be a non-negative safe integer (epoch ms)");
  }
  return value;
}

function assertOptionalQuantFingerprint(value, fieldName) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !QUANT_FINGERPRINT_TOKEN_PATTERN.test(value)) {
    throw new InvalidAssessmentKeyInputError(fieldName, "must be a short technical token (letters/digits/._:- only, max 80 chars) or null/absent");
  }
  return value;
}

/**
 * Serializacao numerica EXATA e deterministica -- NAO e arredondamento
 * (toFixed(N) seria arredondamento e foi rejeitado de proposito: duas
 * leituras quantitativamente diferentes poderiam colapsar na mesma
 * identidade). value.toString() do JS produz a representacao decimal mais
 * curta que reconstroi o MESMO double exatamente (garantia da spec
 * ECMA-262 pra Number::toString) -- preserva toda a precisao real do
 * numero, sem inventar nem descartar digitos. -0 e' canonicalizado pra "0"
 * (mesmo valor numerico de 0, nunca deve virar uma chave diferente so pela
 * distincao de sinal do zero). NaN/Infinito/nao-numero -- SEMPRE erro
 * nomeado, nunca vira null silenciosamente (isso mascararia um bug de
 * calculo upstream como se fosse "sem dado").
 */
function canonicalFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidQuantFingerprintInputError(field);
  }
  return Object.is(value, -0) ? "0" : value.toString();
}

/**
 * Fingerprint canonico dos campos QUANTITATIVOS efetivamente usados pela
 * avaliacao (lib/signal.js::analyze) -- existe para que uma mudanca real
 * de preco/indicador DENTRO do mesmo candle (ainda em formacao) produza
 * uma assessmentKey diferente, mesmo com candleTimestampMs identico. Nunca
 * inclui posicao (qty/entryPrice/stopLoss/takeProfit), saldo, prompt,
 * texto narrativo ou conteudo de Telegram -- so os 7 numeros abaixo + o
 * signal (token curto de uma allowlist fechada).
 *
 * Contrato:
 *   - quant null/undefined -> null (compatibilidade -- modulo puro, callers
 *     que nao tem dado quantitativo disponivel degradam bem)
 *   - quant presente mas nao-objeto, ou qualquer campo numerico obrigatorio
 *     ausente/NaN/infinito/nao-numero -> InvalidQuantFingerprintInputError
 *     (nunca vira null silenciosamente -- isso esconderia um bug real)
 *   - quant.signal fora de {wait,buy,sell} -> InvalidQuantSignalError
 *   - quant.reasons[] (texto/tokens de motivo) NUNCA entra na canonicalizacao
 *
 * SHA-256 COMPLETO (64 hex), sem truncar -- formato "qf:v1:<64 hex>".
 */
function computeQuantFingerprint(quant) {
  if (quant === null || quant === undefined) return null;
  if (typeof quant !== "object" || Array.isArray(quant)) {
    throw new InvalidQuantFingerprintInputError("quant");
  }
  if (typeof quant.signal !== "string" || !QUANT_SIGNAL_ALLOWLIST.has(quant.signal)) {
    throw new InvalidQuantSignalError(quant.signal);
  }

  const indicators = quant.indicators && typeof quant.indicators === "object" && !Array.isArray(quant.indicators) ? quant.indicators : {};

  // Ordem de chaves FIXA (literal abaixo) -- mesma garantia de
  // JSON.stringify usada em computeAssessmentKey, sem precisar de
  // stableStringify recursivo.
  const canonicalFields = {
    fingerprintVersion: QUANT_FINGERPRINT_VERSION,
    signal: quant.signal,
    price: canonicalFiniteNumber(quant.price, "price"),
    emaShort: canonicalFiniteNumber(indicators.emaShort, "indicators.emaShort"),
    emaLong: canonicalFiniteNumber(indicators.emaLong, "indicators.emaLong"),
    rsi: canonicalFiniteNumber(indicators.rsi, "indicators.rsi"),
    stochRsi: canonicalFiniteNumber(indicators.stochRsi, "indicators.stochRsi"),
    obv: canonicalFiniteNumber(indicators.obv, "indicators.obv"),
    atr: canonicalFiniteNumber(indicators.atr, "indicators.atr"),
  };

  const canonicalJson = JSON.stringify(canonicalFields);
  // SHA-256 completo, SEM truncar -- 64 chars hex, mesma disciplina de
  // computeAssessmentKey.
  const digest = crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `${QUANT_FINGERPRINT_PREFIX}:${QUANT_FINGERPRINT_VERSION}:${digest}`;
}

/**
 * Calcula a assessmentKey de uma avaliação lógica do AgentRouter.
 *
 * Campos aceitos (todos obrigatórios, exceto regime/positionSide) -- ver
 * ALLOWED_INPUT_FIELDS, a ÚNICA lista de chaves reconhecidas:
 *   - symbol, interval: token curto (ex.: "SOLUSDT", "15")
 *   - candleTimestampMs: epoch ms do candle/intervalo que ancora esta
 *     avaliação (fechamento ou abertura -- estável, NUNCA "agora")
 *   - triggerReason: token curto já normalizado (ex.: "quant_signal")
 *   - taskClass: uma das 6 classes do AgentRouter budget policy
 *   - promptVersion, schemaVersion: versões do prompt/schema usados
 *   - regime, positionSide (opcionais): rótulos categóricos curtos --
 *     NUNCA quantidade, preço, PnL ou saldo. Ausência, `undefined` e
 *     `null` produzem a MESMA representação canônica (null no JSON) --
 *     nunca hashes diferentes só por essa variação. String vazia é
 *     rejeitada (falha no mesmo padrão de token curto, comprimento
 *     mínimo 1).
 *   - quantFingerprint (opcional): saída de computeQuantFingerprint() --
 *     mesma regra de ausência/`undefined`/`null` do regime/positionSide.
 *
 * QUALQUER campo fora da allowlist (ex.: attemptId, createdAtMs,
 * snapshotAt, prompt, telegramText, apiKey, ou qualquer nome
 * desconhecido) lança UnrecognizedAssessmentKeyFieldError IMEDIATAMENTE --
 * nunca é ignorado silenciosamente. Isso é deliberado: um campo extra
 * passado por engano nunca deve produzir uma chave "aparentemente válida"
 * enquanto mascara um erro de integração. Campo obrigatório ausente ou
 * malformado lança InvalidAssessmentKeyInputError.
 */
function computeAssessmentKey(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidAssessmentKeyInputError("input", "must be a plain object");
  }
  for (const field of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(field)) {
      throw new UnrecognizedAssessmentKeyFieldError(field);
    }
  }

  const canonicalFields = {
    keyAlgoVersion: ASSESSMENT_KEY_VERSION,
    symbol: assertShortToken(input.symbol, "symbol"),
    interval: assertShortToken(input.interval, "interval"),
    candleTimestampMs: assertSafeNonNegativeMs(input.candleTimestampMs, "candleTimestampMs"),
    triggerReason: assertShortToken(input.triggerReason, "triggerReason"),
    taskClass: assertShortToken(input.taskClass, "taskClass"),
    promptVersion: assertShortToken(input.promptVersion, "promptVersion"),
    schemaVersion: assertShortToken(input.schemaVersion, "schemaVersion"),
    regime: assertOptionalShortToken(input.regime, "regime"),
    positionSide: assertOptionalShortToken(input.positionSide, "positionSide"),
    quantFingerprint: assertOptionalQuantFingerprint(input.quantFingerprint, "quantFingerprint"),
  };

  // Ordem de chaves FIXA (literal acima, sempre os mesmos 9 campos) --
  // JSON.stringify de um objeto literal preserva ordem de inserção pra
  // chaves string não-numéricas (garantia da spec ECMA-262). Não há
  // profundidade/forma variável aqui, então não precisa de um
  // stableStringify recursivo como o de aiGateway.js.
  const canonicalJson = JSON.stringify(canonicalFields);

  // SHA-256 completo, SEM truncar -- 64 chars hex. Prefixo + versão +
  // digest cabe folgado em 128 chars (padrão de idempotencyKey do ledger).
  const digest = crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  const key = `${KEY_PREFIX}:${ASSESSMENT_KEY_VERSION}:${digest}`;

  if (!LEDGER_TOKEN_ID_PATTERN.test(key)) {
    // Defensivo -- não deveria disparar dado o formato fixo acima, mas
    // falha fechado em vez de devolver uma chave que o ledger rejeitaria
    // silenciosamente mais tarde (Commit 4c).
    throw new InvalidAssessmentKeyOutputError(key);
  }
  return key;
}

/**
 * Gerador de identidade FÍSICA (uma execução real), separado por
 * construção da identidade LÓGICA acima -- computeAssessmentKey() não
 * aceita attemptId em nenhuma hipótese (fora da allowlist, ver acima).
 * randomUUIDFn injetável (testabilidade, mesmo padrão do resto do
 * projeto). O valor devolvido por randomUUIDFn é validado -- um retorno
 * que não seja um UUID de verdade nunca vira um attemptId aceito
 * silenciosamente.
 */
function createAttemptId({ randomUUIDFn = crypto.randomUUID } = {}) {
  const id = randomUUIDFn();
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new InvalidAttemptIdError(id);
  }
  return id;
}

module.exports = {
  computeAssessmentKey,
  createAttemptId,
  computeQuantFingerprint,
  ASSESSMENT_KEY_VERSION,
  QUANT_FINGERPRINT_VERSION,
  AssessmentKeyError,
  InvalidAssessmentKeyInputError,
  InvalidAssessmentKeyOutputError,
  UnrecognizedAssessmentKeyFieldError,
  InvalidAttemptIdError,
  InvalidQuantFingerprintInputError,
  InvalidQuantSignalError,
};

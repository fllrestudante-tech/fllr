// Politica e gate preventivo de orcamento do AgentRouter (Fase 10 / Commit 3).
//
// Infraestrutura PURA sobre o ledger (lib/aiGateway/agentRouterLedger.js):
// calcula a janela orcamentaria diaria (timezone-aware, DST-safe), aplica
// tetos globais/por-categoria/por-chamada e cria reservas atomicamente. NAO
// integra com lib/aiGateway/aiGateway.js, lib/agentrouterClient.js,
// supervisor, .env, config.toml ou rede -- isso fica para um commit de
// integracao separado. Nada aqui chama nenhum provider de IA.
//
// Dinheiro sempre em micros de dolar (1 USD = 1_000_000), inteiro, nunca
// float. Relogio 100% injetavel -- toda funcao recebe nowMs, nenhuma chama
// Date.now() internamente.
//
// IMPORTANTE: reserveBudget() do ledger e seu contrato de idempotencia
// (janela INCLUSA no payload canonico) permanecem 100% inalterados desde o
// Commit 2. Este modulo usa exclusivamente
// ledger.resolvePolicyIdempotentReservation() -- um helper SEPARADO, aditivo,
// que nunca e chamado por reserveBudget() -- para reconhecer retries mesmo
// apos a janela orcamentaria ter virado, sem ampliar o contrato publico do
// ledger para nenhum outro consumidor.

const ledger = require("./agentRouterLedger");

// --- Erros nomeados -- cada um alcancavel por um caminho real de validacao,
// nenhum reservado para uma situacao que a propria logica ja torna
// impossivel (ex.: nao ha "ReserveBelowEstimateError" porque o valor
// reservado e sempre >= a estimativa por construcao -- ver
// computeMinimumReserveMicrosUsd/tryReserve abaixo). ---

class BudgetPolicyError extends Error {
  constructor(code, message, options) {
    super(message, options); // options.cause (Error nativo, Node >=16.9) preserva a causa original, ex.: SQLITE_BUSY
    this.name = this.constructor.name;
    this.code = code;
  }
}
class UnknownTaskClassError extends BudgetPolicyError {
  constructor(taskClass) {
    super("UNKNOWN_TASK_CLASS", `taskClass desconhecida para esta politica: "${taskClass}"`);
    this.taskClass = taskClass;
  }
}
class UnrecognizedReserveFieldError extends BudgetPolicyError {
  constructor(field) {
    super(
      "UNRECOGNIZED_RESERVE_FIELD",
      `tryReserve() nao reconhece o campo "${field}" -- reservedMicrosUsd (e qualquer outro valor monetario de controle) e sempre calculado pela politica, nunca aceito do chamador`
    );
    this.field = field;
  }
}
class AtomicReservationUnavailableError extends BudgetPolicyError {
  constructor(idempotencyKey, options) {
    super(
      "ATOMIC_RESERVATION_UNAVAILABLE",
      `Nao foi possivel obter o lock de escritor para "${idempotencyKey}" dentro do busy_timeout configurado na conexao`,
      options
    );
    this.idempotencyKey = idempotencyKey;
  }
}
class InvalidBudgetPolicyError extends BudgetPolicyError {
  constructor(detail) {
    super("INVALID_BUDGET_POLICY", `Configuracao de politica invalida: ${detail}`);
  }
}
class InvalidTimezoneError extends BudgetPolicyError {
  constructor(timezone) {
    super("INVALID_TIMEZONE", `Timezone invalido ou nao suportado pelo Intl desta maquina: ${JSON.stringify(timezone)}`);
    this.timezone = timezone;
  }
}
class InvalidWindowStartError extends BudgetPolicyError {
  constructor(detail) {
    super("INVALID_WINDOW_START", detail);
  }
}
class EstimatedCostExceedsPerCallLimitError extends BudgetPolicyError {
  constructor(taskClass, estimatedMicrosUsd, perCallLimitMicrosUsd) {
    super(
      "ESTIMATED_COST_EXCEEDS_PER_CALL_LIMIT",
      `estimatedMicrosUsd (${estimatedMicrosUsd}) excede o teto por chamada da classe "${taskClass}" (${perCallLimitMicrosUsd}) -- rejeitado, sem truncar`
    );
    this.taskClass = taskClass;
    this.estimatedMicrosUsd = estimatedMicrosUsd;
    this.perCallLimitMicrosUsd = perCallLimitMicrosUsd;
  }
}
class GlobalBudgetExhaustedError extends BudgetPolicyError {
  constructor(currentTotalMicrosUsd, requestedMicrosUsd, capMicrosUsd) {
    super(
      "GLOBAL_BUDGET_EXHAUSTED",
      `Orcamento global esgotado: atual ${currentTotalMicrosUsd} + solicitado ${requestedMicrosUsd} excederia o teto operacional ${capMicrosUsd}`
    );
    this.currentTotalMicrosUsd = currentTotalMicrosUsd;
    this.requestedMicrosUsd = requestedMicrosUsd;
    this.capMicrosUsd = capMicrosUsd;
  }
}
class CategoryBudgetExhaustedError extends BudgetPolicyError {
  constructor(category, currentTotalMicrosUsd, requestedMicrosUsd, capMicrosUsd) {
    super(
      "CATEGORY_BUDGET_EXHAUSTED",
      `Orcamento da categoria "${category}" esgotado: atual ${currentTotalMicrosUsd} + solicitado ${requestedMicrosUsd} excederia o teto ${capMicrosUsd}`
    );
    this.category = category;
    this.currentTotalMicrosUsd = currentTotalMicrosUsd;
    this.requestedMicrosUsd = requestedMicrosUsd;
    this.capMicrosUsd = capMicrosUsd;
  }
}

// --- Valores iniciais (US$10/dia nominal, US$9 operacional, US$1 de
// margem de reconciliacao, categorias somando exatamente o teto
// operacional). Podem ser sobrescritos via options em
// createAgentRouterBudgetPolicy -- estes sao apenas o default. ---

const DEFAULT_POLICY_CONFIG = Object.freeze({
  nominalCapMicrosUsd: 10_000_000,
  operationalCapMicrosUsd: 9_000_000,
  reconciliationMarginMicrosUsd: 1_000_000,
  categoryCapsMicrosUsd: Object.freeze({
    triage: 1_800_000, // 20%
    recurring_analysis: 3_150_000, // 35%
    research_innovation: 2_700_000, // 30%
    event_review_reserve: 1_350_000, // 15%
  }),
  perCallLimitsMicrosUsd: Object.freeze({
    health_check: 100_000, // US$0.10
    triage: 100_000, // US$0.10
    normal_analysis: 200_000, // US$0.20
    deep_analysis: 500_000, // US$0.50
    research_innovation: 1_000_000, // US$1.00
    critical_review: 500_000, // US$0.50
  }),
  taskClassToCategory: Object.freeze({
    health_check: "triage",
    triage: "triage",
    normal_analysis: "recurring_analysis",
    deep_analysis: "recurring_analysis",
    research_innovation: "research_innovation",
    critical_review: "event_review_reserve",
  }),
  observedMarginRatio: 0.5,
  minAbsoluteMicrosUsd: 10_000, // US$0.01
  timezone: "America/Sao_Paulo",
  windowStartLocal: "00:00",
});

function assertSafeIntNonNegative(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidBudgetPolicyError(`${fieldName} deve ser inteiro seguro nao-negativo, veio: ${JSON.stringify(value)}`);
  }
  return value;
}

function isValidIanaTimezone(tz) {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    // eslint-disable-next-line no-new -- so testamos se o Intl aceita o timezone
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseWindowStartLocal(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    throw new InvalidBudgetPolicyError(`windowStartLocal invalido: ${JSON.stringify(value)} (esperado "HH:MM", 00:00-23:59)`);
  }
  const [hh, mm] = value.split(":").map((s) => parseInt(s, 10));
  return { hh, mm };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// --- Resolucao DST-safe de horario civil local -> instante UTC ---
//
// Enumera TODOS os offsets UTC distintos observados numa janela de
// amostragem de +-36h ao redor do palpite ingenuo, em passos de 15min (a
// menor granularidade real de offset conhecida -- Nepal/Chatham usam
// 45min). Para cada offset distinto, calcula um candidato e confirma via
// ida-e-volta (Intl) se ele realmente formata de volta para o horario local
// pedido. NUNCA presume que existem exatamente 2 offsets nem em que
// instante a transicao ocorre.
//
// 0 candidatos validos = horario inexistente (gap de "spring forward") ->
// rejeitado. 1 candidato = normal. 2+ candidatos = ambiguo (sobreposicao de
// "fall back") -> rejeitado, nunca escolhe silenciosamente qual dos dois.
const DST_SAMPLE_RANGE_MS = 36 * 60 * 60 * 1000;
const DST_SAMPLE_STEP_MS = 15 * 60 * 1000;

function getLocalDateTimeParts(ms, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(ms))) map[p.type] = p.value;
  return {
    y: parseInt(map.year, 10),
    m: parseInt(map.month, 10),
    d: parseInt(map.day, 10),
    hh: parseInt(map.hour, 10) % 24, // h23 pode emitir "24" para meia-noite em algumas implementacoes
    mm: parseInt(map.minute, 10),
    ss: parseInt(map.second, 10),
  };
}

function getUtcOffsetMs(ms, timezone) {
  const p = getLocalDateTimeParts(ms, timezone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - ms;
}

function formatMatchesLocal(candidateMs, timezone, y, m, d, hh, mm) {
  const p = getLocalDateTimeParts(candidateMs, timezone);
  return p.y === y && p.m === m && p.d === d && p.hh === hh && p.mm === mm;
}

function resolveLocalTimeToUtcMs(y, m, d, hh, mm, timezone) {
  const naiveUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);

  const distinctOffsets = new Set();
  for (let t = naiveUtc - DST_SAMPLE_RANGE_MS; t <= naiveUtc + DST_SAMPLE_RANGE_MS; t += DST_SAMPLE_STEP_MS) {
    distinctOffsets.add(getUtcOffsetMs(t, timezone));
  }

  const validCandidates = new Set();
  for (const offset of distinctOffsets) {
    const candidate = naiveUtc - offset;
    if (formatMatchesLocal(candidate, timezone, y, m, d, hh, mm)) validCandidates.add(candidate);
  }

  if (validCandidates.size === 0) {
    throw new InvalidWindowStartError(`horario local inexistente (gap de DST "spring forward"): ${y}-${pad2(m)}-${pad2(d)} ${pad2(hh)}:${pad2(mm)} em ${timezone}`);
  }
  if (validCandidates.size > 1) {
    throw new InvalidWindowStartError(
      `horario local ambiguo (${validCandidates.size} instantes UTC validos, sobreposicao de DST "fall back"): ${y}-${pad2(m)}-${pad2(d)} ${pad2(hh)}:${pad2(mm)} em ${timezone} -- rejeitado, nunca escolhe silenciosamente`
    );
  }
  return [...validCandidates][0];
}

function getLocalDateParts(ms, timezone) {
  const p = getLocalDateTimeParts(ms, timezone);
  return { y: p.y, m: p.m, d: p.d };
}

// Avanca/retrocede N dias CIVIS (calendario puro, sem dependencia de
// timezone -- Date.UTC normaliza overflow de mes/ano corretamente).
function shiftCivilDate(y, m, d, deltaDays) {
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * Janela orcamentaria diaria [windowStartMs, windowEndMs) contendo nowMs,
 * no timezone/horario-de-inicio configurados. windowStartLocal != "00:00" e
 * suportado: se nowMs cair antes do horario de inicio de "hoje" (no
 * calendario local), a janela e a de ONTEM->hoje.
 */
function computeWindow(nowMs, timezone, { hh, mm }) {
  const today = getLocalDateParts(nowMs, timezone);
  let startDate = today;
  let start = resolveLocalTimeToUtcMs(startDate.y, startDate.m, startDate.d, hh, mm, timezone);

  // windowStartLocal != "00:00": se nowMs cair ANTES do horario de inicio
  // de hoje, a janela que contem nowMs e a de ONTEM->hoje.
  if (nowMs < start) {
    startDate = shiftCivilDate(today.y, today.m, today.d, -1);
    start = resolveLocalTimeToUtcMs(startDate.y, startDate.m, startDate.d, hh, mm, timezone);
  }

  const endDate = shiftCivilDate(startDate.y, startDate.m, startDate.d, 1);
  const end = resolveLocalTimeToUtcMs(endDate.y, endDate.m, endDate.d, hh, mm, timezone);

  if (end <= start) throw new InvalidWindowStartError(`janela calculada invalida (end <= start): start=${start} end=${end}`);
  return { windowStartMs: start, windowEndMs: end, timezone };
}

/**
 * Minimo conservador de reserva, dado o estado de confianca do preco:
 * - "unknown": nao ha nenhuma base de preco confiavel -- reserva o teto
 *   inteiro da classe (pior caso absoluto).
 * - "observed": preco observado mas nao confirmado pelo provider -- reserva
 *   o maior entre a estimativa, uma margem conservadora (fracao do teto da
 *   classe) e o piso absoluto.
 * - "confirmed": preco confirmado pelo provider -- reserva o maior entre a
 *   estimativa e o piso absoluto (sem margem extra).
 * NUNCA faz clamp para baixo do teto -- se o resultado exceder o teto da
 * classe, quem chama (tryReserve) falha fechado com InvalidBudgetPolicyError
 * em vez de truncar silenciosamente.
 */
function computeMinimumReserveMicrosUsd({ priceSourceStatus, estimatedMicrosUsd, perCallLimitMicrosUsd, observedMarginRatio, minAbsoluteMicrosUsd }) {
  if (priceSourceStatus === "unknown") return perCallLimitMicrosUsd;
  if (priceSourceStatus === "observed") {
    return Math.max(estimatedMicrosUsd, Math.ceil(perCallLimitMicrosUsd * observedMarginRatio), minAbsoluteMicrosUsd);
  }
  return Math.max(estimatedMicrosUsd, minAbsoluteMicrosUsd); // "confirmed"
}

function sumEffectiveMicrosUsdForTaskClasses(db, { windowStartMs, windowEndMs, taskClasses }) {
  if (taskClasses.length === 0) return 0;
  const placeholders = taskClasses.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT SUM(${ledger.EFFECTIVE_MICROS_USD_CASE_SQL}) AS total
       FROM agentrouter_budget_ledger
       WHERE budget_window_start_ms = ? AND budget_window_end_ms = ? AND task_class IN (${placeholders})`
    )
    .get(windowStartMs, windowEndMs, ...taskClasses);
  const total = row.total ?? 0;
  if (!Number.isSafeInteger(total)) throw new ledger.UnsafeSumError(`SUM() por categoria retornou valor fora do intervalo inteiro seguro: ${total}`);
  return total;
}

/**
 * Cria a politica de orcamento do AgentRouter. Toda validacao de
 * configuracao roda AQUI, na criacao -- fail-fast, nunca em tempo de
 * chamada. Os objetos de configuracao sao copiados e congelados
 * (Object.freeze) para nao poderem mudar durante uma reserva em andamento.
 */
function createAgentRouterBudgetPolicy(options = {}) {
  const cfg = { ...DEFAULT_POLICY_CONFIG, ...options };
  const {
    nominalCapMicrosUsd,
    operationalCapMicrosUsd,
    reconciliationMarginMicrosUsd,
    categoryCapsMicrosUsd,
    perCallLimitsMicrosUsd,
    taskClassToCategory,
    observedMarginRatio,
    minAbsoluteMicrosUsd,
    timezone,
    windowStartLocal,
  } = cfg;

  assertSafeIntNonNegative(nominalCapMicrosUsd, "nominalCapMicrosUsd");
  assertSafeIntNonNegative(operationalCapMicrosUsd, "operationalCapMicrosUsd");
  assertSafeIntNonNegative(reconciliationMarginMicrosUsd, "reconciliationMarginMicrosUsd");
  if (operationalCapMicrosUsd > nominalCapMicrosUsd) {
    throw new InvalidBudgetPolicyError(`operationalCapMicrosUsd (${operationalCapMicrosUsd}) nao pode exceder nominalCapMicrosUsd (${nominalCapMicrosUsd})`);
  }
  if (reconciliationMarginMicrosUsd !== nominalCapMicrosUsd - operationalCapMicrosUsd) {
    throw new InvalidBudgetPolicyError(
      `reconciliationMarginMicrosUsd (${reconciliationMarginMicrosUsd}) deve ser exatamente nominalCapMicrosUsd - operationalCapMicrosUsd (${nominalCapMicrosUsd - operationalCapMicrosUsd})`
    );
  }

  if (typeof categoryCapsMicrosUsd !== "object" || categoryCapsMicrosUsd === null) {
    throw new InvalidBudgetPolicyError("categoryCapsMicrosUsd deve ser um objeto");
  }
  const categories = Object.keys(categoryCapsMicrosUsd);
  if (categories.length === 0) throw new InvalidBudgetPolicyError("categoryCapsMicrosUsd nao pode ser vazio");
  let categorySum = 0;
  for (const cat of categories) {
    assertSafeIntNonNegative(categoryCapsMicrosUsd[cat], `categoryCapsMicrosUsd.${cat}`);
    categorySum += categoryCapsMicrosUsd[cat];
  }
  if (categorySum !== operationalCapMicrosUsd) {
    throw new InvalidBudgetPolicyError(`soma das categorias (${categorySum}) deve ser exatamente igual ao teto operacional (${operationalCapMicrosUsd})`);
  }

  if (typeof perCallLimitsMicrosUsd !== "object" || perCallLimitsMicrosUsd === null) {
    throw new InvalidBudgetPolicyError("perCallLimitsMicrosUsd deve ser um objeto");
  }
  for (const tc of Object.keys(perCallLimitsMicrosUsd)) {
    assertSafeIntNonNegative(perCallLimitsMicrosUsd[tc], `perCallLimitsMicrosUsd.${tc}`);
  }

  if (typeof taskClassToCategory !== "object" || taskClassToCategory === null) {
    throw new InvalidBudgetPolicyError("taskClassToCategory deve ser um objeto");
  }
  for (const tc of Object.keys(taskClassToCategory)) {
    const cat = taskClassToCategory[tc];
    if (!categories.includes(cat)) throw new InvalidBudgetPolicyError(`taskClassToCategory.${tc} referencia categoria inexistente: "${cat}"`);
    if (!(tc in perCallLimitsMicrosUsd)) throw new InvalidBudgetPolicyError(`taskClassToCategory.${tc} nao tem limite correspondente em perCallLimitsMicrosUsd`);
  }
  for (const tc of Object.keys(perCallLimitsMicrosUsd)) {
    if (!(tc in taskClassToCategory)) throw new InvalidBudgetPolicyError(`perCallLimitsMicrosUsd.${tc} nao tem categoria correspondente em taskClassToCategory`);
  }

  if (typeof observedMarginRatio !== "number" || !Number.isFinite(observedMarginRatio) || observedMarginRatio < 0 || observedMarginRatio > 1) {
    throw new InvalidBudgetPolicyError(`observedMarginRatio deve ser um numero finito entre 0 e 1, veio: ${JSON.stringify(observedMarginRatio)}`);
  }

  assertSafeIntNonNegative(minAbsoluteMicrosUsd, "minAbsoluteMicrosUsd");
  if (minAbsoluteMicrosUsd <= 0) throw new InvalidBudgetPolicyError("minAbsoluteMicrosUsd deve ser positivo (> 0)");

  if (!isValidIanaTimezone(timezone)) throw new InvalidTimezoneError(timezone);

  const { hh, mm } = parseWindowStartLocal(windowStartLocal);

  const frozenCategoryCaps = Object.freeze({ ...categoryCapsMicrosUsd });
  const frozenPerCallLimits = Object.freeze({ ...perCallLimitsMicrosUsd });
  const frozenTaskClassToCategory = Object.freeze({ ...taskClassToCategory });
  const frozenCategories = Object.freeze([...categories]);
  const classesByCategory = Object.freeze(
    Object.fromEntries(frozenCategories.map((cat) => [cat, Object.keys(frozenTaskClassToCategory).filter((tc) => frozenTaskClassToCategory[tc] === cat)]))
  );

  function computeWindowFn(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new InvalidBudgetPolicyError(`nowMs deve ser epoch ms inteiro nao-negativo, veio: ${JSON.stringify(nowMs)}`);
    return computeWindow(nowMs, timezone, { hh, mm });
  }

  /**
   * Estado atual da janela que contem nowMs: total global, total por
   * categoria configurada, e unmappedMicrosUsd -- soma de linhas na janela
   * cuja task_class NAO esta em taskClassToCategory (ex.: classe historica
   * de uma configuracao anterior, ou linha criada por outro caminho que nao
   * esta politica). Invariante sempre valida:
   *   soma(byCategory[*].totalMicrosUsd) + unmappedMicrosUsd === globalTotalMicrosUsd
   * Nomes de classe/categoria configurados sao usados SOMENTE como
   * parametros SQL vinculados (?), nunca interpolados na string da consulta
   * (ver sumEffectiveMicrosUsdForTaskClasses).
   */
  function getState(db, nowMs) {
    const { windowStartMs, windowEndMs, timezone: tz } = computeWindowFn(nowMs);
    const global = ledger.getBudgetStateForWindow(db, { windowStartMs, windowEndMs });
    const byCategory = {};
    for (const cat of frozenCategories) {
      byCategory[cat] = {
        totalMicrosUsd: sumEffectiveMicrosUsdForTaskClasses(db, { windowStartMs, windowEndMs, taskClasses: classesByCategory[cat] }),
        capMicrosUsd: frozenCategoryCaps[cat],
      };
    }

    const knownClasses = new Set(Object.keys(frozenTaskClassToCategory));
    const distinctClassesInWindow = db
      .prepare(`SELECT DISTINCT task_class FROM agentrouter_budget_ledger WHERE budget_window_start_ms = ? AND budget_window_end_ms = ?`)
      .all(windowStartMs, windowEndMs)
      .map((r) => r.task_class);
    const unmappedClasses = distinctClassesInWindow.filter((tc) => !knownClasses.has(tc));
    const unmappedMicrosUsd = sumEffectiveMicrosUsdForTaskClasses(db, { windowStartMs, windowEndMs, taskClasses: unmappedClasses });

    return {
      windowStartMs,
      windowEndMs,
      timezone: tz,
      globalTotalMicrosUsd: global.totalMicrosUsd,
      operationalCapMicrosUsd,
      byCategory,
      unmappedMicrosUsd,
    };
  }

  /**
   * Tenta criar uma reserva atomicamente:
   *   1. idempotencia PRIMEIRO (resolvePolicyIdempotentReservation), antes
   *      de qualquer validacao de configuracao/orcamento que possa variar
   *      entre chamadas -- config mutavel ou orcamento diferente NUNCA
   *      bloqueia o reconhecimento de um retry de payload identico.
   *   2. so entao: taskClass conhecida, estimativa <= teto por chamada
   *      (sem truncar), minimo conservador <= teto por chamada (sem
   *      truncar), janela atual, teto global, teto por categoria.
   *   3. reserveBudget() -- mesma transacao BEGIN IMMEDIATE, mesmo lock de
   *      escritor do passo 1: nao ha intervalo de corrida entre o helper
   *      retornar null e a insercao.
   *
   * MUDANCA DE CONTRATO EM RELACAO A UMA API ANTERIOR (nunca publicada):
   *   - tryReserve() NAO aceita um valor reservado escolhido pelo chamador
   *     (nao existe parametro "reservedMicrosUsd" nem "requestedReserveMicrosUsd"
   *     em callOpts) -- reservedMicrosUsd e SEMPRE atribuido pela politica,
   *     como max(estimatedMicrosUsd, minimumReserveMicrosUsd), justamente
   *     para impedir que o chamador reduza artificialmente a reserva.
   *   - Por isso reservedMicrosUsd fica FORA do payload logico comparado por
   *     ledger.resolvePolicyIdempotentReservation() -- ele e derivado da
   *     configuracao vigente no momento da criacao, nao da intencao do
   *     chamador, entao nao faz sentido compara-lo num retry.
   *   - Qualquer campo em callOpts fora da lista permitida (abaixo) e
   *     REJEITADO com UnrecognizedReserveFieldError -- nunca silenciosamente
   *     ignorado. Isso cobre em particular um eventual "reservedMicrosUsd"
   *     ou "requestedReserveMicrosUsd" que um chamador antigo/desatualizado
   *     ainda tente enviar.
   *   - ledger.reserveBudget() chamado DIRETAMENTE (fora desta politica)
   *     continua exigindo e comparando reservedMicrosUsd e a janela como
   *     campos canonicos -- contrato inalterado desde o Commit 2.
   *   - Um retry reconhecido por esta politica (resolvePolicyIdempotentReservation
   *     retornando a linha existente) devolve o reservedMicrosUsd
   *     ORIGINALMENTE PERSISTIDO, mesmo que a politica atual (config
   *     diferente) calculasse um valor diferente para os mesmos
   *     estimatedMicrosUsd/priceSourceStatus.
   *
   * Erros do SQLite: apenas SQLITE_BUSY (lock de escritor nao obtido dentro
   * do busy_timeout) e traduzido para AtomicReservationUnavailableError,
   * preservando o erro original em `.cause`. Qualquer outro erro (incluindo
   * erros do proprio SQLite nao relacionados a busy) propaga tal como o
   * driver o produziu, sem substituicao.
   */
  const TRY_RESERVE_ALLOWED_FIELDS = new Set([
    "idempotencyKey",
    "correlationId",
    "model",
    "taskClass",
    "estimatedMicrosUsd",
    "priceSource",
    "priceSourceStatus",
    "pricingTableVersion",
    "expiresAtMs",
    "nowMs",
  ]);

  function tryReserve(db, callOpts) {
    for (const field of Object.keys(callOpts)) {
      if (!TRY_RESERVE_ALLOWED_FIELDS.has(field)) throw new UnrecognizedReserveFieldError(field);
    }

    const { idempotencyKey, correlationId, model, taskClass, estimatedMicrosUsd, priceSource, priceSourceStatus, pricingTableVersion, expiresAtMs, nowMs } = callOpts;

    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new InvalidBudgetPolicyError(`nowMs deve ser epoch ms inteiro nao-negativo, veio: ${JSON.stringify(nowMs)}`);

    const runTransaction = () => {
      const existing = ledger.resolvePolicyIdempotentReservation(db, {
        idempotencyKey,
        correlationId,
        model,
        taskClass,
        estimatedMicrosUsd,
        priceSource,
        priceSourceStatus,
        pricingTableVersion,
        expiresAtMs,
      });
      if (existing) return existing;

      const perCallLimitMicrosUsd = frozenPerCallLimits[taskClass];
      if (perCallLimitMicrosUsd === undefined) throw new UnknownTaskClassError(taskClass);
      const category = frozenTaskClassToCategory[taskClass];

      if (estimatedMicrosUsd > perCallLimitMicrosUsd) {
        throw new EstimatedCostExceedsPerCallLimitError(taskClass, estimatedMicrosUsd, perCallLimitMicrosUsd);
      }

      const minimumReserveMicrosUsd = computeMinimumReserveMicrosUsd({
        priceSourceStatus,
        estimatedMicrosUsd,
        perCallLimitMicrosUsd,
        observedMarginRatio,
        minAbsoluteMicrosUsd,
      });
      if (minimumReserveMicrosUsd > perCallLimitMicrosUsd) {
        throw new InvalidBudgetPolicyError(
          `minimo calculado (${minimumReserveMicrosUsd}) excede o teto por chamada da classe "${taskClass}" (${perCallLimitMicrosUsd}) -- configuracao inconsistente`
        );
      }

      // NUNCA um clamp para baixo -- so um maximo entre dois valores ja
      // individualmente validados contra o teto, portanto o resultado
      // tambem respeita o teto (e sempre >= estimatedMicrosUsd).
      const reservedMicrosUsd = Math.max(estimatedMicrosUsd, minimumReserveMicrosUsd);

      const { windowStartMs, windowEndMs, timezone: tz } = computeWindow(nowMs, timezone, { hh, mm });

      const globalState = ledger.getBudgetStateForWindow(db, { windowStartMs, windowEndMs });
      if (globalState.totalMicrosUsd + reservedMicrosUsd > operationalCapMicrosUsd) {
        throw new GlobalBudgetExhaustedError(globalState.totalMicrosUsd, reservedMicrosUsd, operationalCapMicrosUsd);
      }

      const categoryTotal = sumEffectiveMicrosUsdForTaskClasses(db, { windowStartMs, windowEndMs, taskClasses: classesByCategory[category] });
      const categoryCap = frozenCategoryCaps[category];
      if (categoryTotal + reservedMicrosUsd > categoryCap) {
        throw new CategoryBudgetExhaustedError(category, categoryTotal, reservedMicrosUsd, categoryCap);
      }

      return ledger.reserveBudget(db, {
        idempotencyKey,
        correlationId,
        model,
        taskClass,
        estimatedMicrosUsd,
        reservedMicrosUsd,
        priceSource,
        priceSourceStatus,
        pricingTableVersion,
        budgetWindowStartMs: windowStartMs,
        budgetWindowEndMs: windowEndMs,
        budgetWindowTimezone: tz,
        expiresAtMs,
        nowMs,
      });
    };

    try {
      return db.transaction(runTransaction).immediate();
    } catch (err) {
      if (err && err.code === "SQLITE_BUSY") {
        throw new AtomicReservationUnavailableError(idempotencyKey, { cause: err });
      }
      throw err;
    }
  }

  return {
    computeWindow: computeWindowFn,
    getState,
    tryReserve,
  };
}

module.exports = {
  createAgentRouterBudgetPolicy,
  resolveLocalTimeToUtcMs,
  DEFAULT_POLICY_CONFIG,
  BudgetPolicyError,
  UnknownTaskClassError,
  UnrecognizedReserveFieldError,
  AtomicReservationUnavailableError,
  InvalidBudgetPolicyError,
  InvalidTimezoneError,
  InvalidWindowStartError,
  EstimatedCostExceedsPerCallLimitError,
  GlobalBudgetExhaustedError,
  CategoryBudgetExhaustedError,
};

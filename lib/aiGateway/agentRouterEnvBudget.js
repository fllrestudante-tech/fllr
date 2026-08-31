// Orcamento diario/mensal do AgentRouter vindo de variaveis de ambiente.
//
// So e relevante quando AGENTROUTER_BUDGET_ENABLED === "true" (config.js ja
// valida essa flag em si, fail-closed, string exata). Este modulo NUNCA
// escolhe um valor numerico proprio -- exige AGENTROUTER_DAILY_BUDGET_USD e
// AGENTROUTER_MONTHLY_BUDGET_USD explicitamente no ambiente. Ausencia,
// formato invalido, ou incoerencia (mensal < diario, qualquer um <= 0)
// bloqueia ANTES de qualquer chamada AgentRouter -- nunca assume um
// orcamento default silencioso quando a flag esta ligada.
//
// O teto diario validado e usado para ESCALAR proporcionalmente (nunca
// redistribuir arbitrariamente) as categorias/limites-por-chamada do
// DEFAULT_POLICY_CONFIG existente em agentRouterBudgetPolicy.js, preservando
// exatamente as mesmas proporcoes relativas. A ultima categoria (ordem de
// Object.keys) absorve o resto do arredondamento, garantindo por construcao
// que a soma das categorias bate exatamente com o teto operacional --
// invariante exigido por createAgentRouterBudgetPolicy(). Qualquer
// inconsistencia residual e pega pela propria validacao exaustiva de
// createAgentRouterBudgetPolicy (fail-closed em dobro, nao so por confianca
// nesta escala).
//
// O teto mensal validado NAO existe em nenhum lugar do sistema de orcamento
// existente (que so tem janela diaria com DST-safe timezone local) -- e
// tratado aqui como uma checagem INDEPENDENTE e mais simples, usando um mes
// calendario UTC puro (sem fuso horario civil), reaproveitando a expressao
// SQL ja exportada por agentRouterLedger.js (EFFECTIVE_MICROS_USD_CASE_SQL)
// sem alterar agentRouterLedger.js/agentRouterBudgetPolicy.js/
// agentRouterGate.js.

const decimalSafety = require("../decimalSafety");
const { DEFAULT_POLICY_CONFIG } = require("./agentRouterBudgetPolicy");
const { EFFECTIVE_MICROS_USD_CASE_SQL } = require("./agentRouterLedger");

const MICROS_PER_USD_DECIMALS = 6;

class EnvBudgetConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class MissingEnvBudgetError extends EnvBudgetConfigError {
  constructor(fieldName) {
    super("MISSING_ENV_BUDGET", `${fieldName} ausente -- obrigatorio quando AGENTROUTER_BUDGET_ENABLED=true`);
    this.fieldName = fieldName;
  }
}

class InvalidEnvBudgetValueError extends EnvBudgetConfigError {
  constructor(fieldName, detail) {
    super("INVALID_ENV_BUDGET_VALUE", `${fieldName}: ${detail}`);
    this.fieldName = fieldName;
  }
}

class IncoherentEnvBudgetError extends EnvBudgetConfigError {
  constructor(dailyRaw, monthlyRaw) {
    super(
      "INCOHERENT_ENV_BUDGET",
      `AGENTROUTER_MONTHLY_BUDGET_USD (${monthlyRaw}) nao pode ser menor que AGENTROUTER_DAILY_BUDGET_USD (${dailyRaw})`
    );
  }
}

class MonthlyBudgetExhaustedError extends EnvBudgetConfigError {
  constructor(currentTotalMicrosUsd, capMicrosUsd) {
    super("MONTHLY_BUDGET_EXHAUSTED", `Orcamento mensal esgotado: gasto atual ${currentTotalMicrosUsd} >= teto ${capMicrosUsd} (micros USD)`);
    this.currentTotalMicrosUsd = currentTotalMicrosUsd;
    this.capMicrosUsd = capMicrosUsd;
  }
}

// decimalSafety.js não exporta toScaledBigInt (helper interno) -- réplica
// local mínima da mesma lógica de truncamento (nunca arredonda pra cima),
// só pra converter o decimal JÁ VALIDADO por parseStrictDecimal em micros de
// USD inteiros.
function usdDecimalStringToMicros(decimalStr) {
  const [intPart, fracPart = ""] = decimalStr.split(".");
  const fracTruncated = fracPart.slice(0, MICROS_PER_USD_DECIMALS).padEnd(MICROS_PER_USD_DECIMALS, "0");
  return BigInt(intPart + fracTruncated);
}

function parseUsdEnvToMicros(raw, fieldName) {
  let str;
  try {
    str = decimalSafety.parseStrictDecimal(raw, fieldName);
  } catch (err) {
    throw new InvalidEnvBudgetValueError(fieldName, err.message);
  }
  const scaled = usdDecimalStringToMicros(str);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidEnvBudgetValueError(fieldName, `valor grande demais (${str})`);
  }
  return Number(scaled);
}

/**
 * Le e valida AGENTROUTER_DAILY_BUDGET_USD / AGENTROUTER_MONTHLY_BUDGET_USD.
 * Lanca EnvBudgetConfigError (nunca outro tipo) se ausente/invalido/
 * incoerente -- nunca usa um default silencioso.
 */
function resolveEnvBudgetMicrosUsd(env = process.env) {
  const dailyRaw = env.AGENTROUTER_DAILY_BUDGET_USD;
  const monthlyRaw = env.AGENTROUTER_MONTHLY_BUDGET_USD;

  if (dailyRaw === undefined || dailyRaw === "") throw new MissingEnvBudgetError("AGENTROUTER_DAILY_BUDGET_USD");
  if (monthlyRaw === undefined || monthlyRaw === "") throw new MissingEnvBudgetError("AGENTROUTER_MONTHLY_BUDGET_USD");

  const dailyMicrosUsd = parseUsdEnvToMicros(dailyRaw, "AGENTROUTER_DAILY_BUDGET_USD");
  const monthlyMicrosUsd = parseUsdEnvToMicros(monthlyRaw, "AGENTROUTER_MONTHLY_BUDGET_USD");

  if (monthlyMicrosUsd < dailyMicrosUsd) {
    throw new IncoherentEnvBudgetError(dailyRaw, monthlyRaw);
  }

  return { dailyMicrosUsd, monthlyMicrosUsd };
}

function scaleMicros(valueMicros, numeratorMicros, denominatorMicros) {
  if (denominatorMicros <= 0) return 0;
  return Number((BigInt(valueMicros) * BigInt(numeratorMicros)) / BigInt(denominatorMicros));
}

/**
 * Constroi as opcoes de politica DIARIA (createAgentRouterBudgetPolicy) a
 * partir do teto diario validado -- reaproveita as PROPORCOES padrao de
 * categoria/limite-por-chamada de DEFAULT_POLICY_CONFIG (nunca inventa uma
 * distribuicao nova), so escalando pro novo teto. Campos nao-monetarios
 * (timezone, windowStartLocal, taskClassToCategory, observedMarginRatio,
 * minAbsoluteMicrosUsd) sao deliberadamente omitidos para herdar o default
 * inalterado.
 */
function buildDailyPolicyOptionsFromMicros(dailyMicrosUsd, def = DEFAULT_POLICY_CONFIG) {
  if (!Number.isSafeInteger(dailyMicrosUsd) || dailyMicrosUsd <= 0) {
    throw new InvalidEnvBudgetValueError("AGENTROUTER_DAILY_BUDGET_USD", `micros resultantes invalidos: ${dailyMicrosUsd}`);
  }

  const nominalCapMicrosUsd = dailyMicrosUsd;
  const operationalCapMicrosUsd = scaleMicros(def.operationalCapMicrosUsd, dailyMicrosUsd, def.nominalCapMicrosUsd);
  const reconciliationMarginMicrosUsd = nominalCapMicrosUsd - operationalCapMicrosUsd;

  const categoryNames = Object.keys(def.categoryCapsMicrosUsd);
  const categoryCapsMicrosUsd = {};
  let categoryAssigned = 0;
  categoryNames.forEach((name, idx) => {
    if (idx === categoryNames.length - 1) {
      categoryCapsMicrosUsd[name] = operationalCapMicrosUsd - categoryAssigned;
      return;
    }
    const share = scaleMicros(def.categoryCapsMicrosUsd[name], dailyMicrosUsd, def.nominalCapMicrosUsd);
    categoryCapsMicrosUsd[name] = share;
    categoryAssigned += share;
  });

  const perCallLimitsMicrosUsd = {};
  for (const tc of Object.keys(def.perCallLimitsMicrosUsd)) {
    const category = def.taskClassToCategory[tc];
    const scaledLimit = scaleMicros(def.perCallLimitsMicrosUsd[tc], dailyMicrosUsd, def.nominalCapMicrosUsd);
    perCallLimitsMicrosUsd[tc] = Math.min(scaledLimit, categoryCapsMicrosUsd[category]);
  }

  return {
    nominalCapMicrosUsd,
    operationalCapMicrosUsd,
    reconciliationMarginMicrosUsd,
    categoryCapsMicrosUsd,
    perCallLimitsMicrosUsd,
  };
}

function computeUtcMonthWindow(nowMs) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const monthStartMs = Date.UTC(y, m, 1, 0, 0, 0, 0);
  const monthEndMs = Date.UTC(y, m + 1, 1, 0, 0, 0, 0);
  return { monthStartMs, monthEndMs };
}

function getMonthlySpendMicrosUsd(db, { monthStartMs, monthEndMs }) {
  const row = db
    .prepare(`SELECT SUM(${EFFECTIVE_MICROS_USD_CASE_SQL}) AS total FROM agentrouter_budget_ledger WHERE created_at_ms >= ? AND created_at_ms < ?`)
    .get(monthStartMs, monthEndMs);
  const total = row && row.total != null ? row.total : 0;
  if (!Number.isSafeInteger(total)) {
    throw new EnvBudgetConfigError("UNSAFE_MONTHLY_SUM", `SUM() mensal fora do intervalo inteiro seguro: ${total}`);
  }
  return total;
}

/**
 * Checagem INDEPENDENTE de teto mensal (mes calendario UTC). Lanca
 * MonthlyBudgetExhaustedError (fail-closed) se o gasto acumulado do mes ja
 * atingiu ou excedeu o teto mensal validado -- nunca deixa passar so porque
 * a janela diaria isolada ainda tem espaco.
 */
function assertMonthlyBudgetAvailable(db, { nowMs, monthlyCapMicrosUsd }) {
  if (!Number.isSafeInteger(monthlyCapMicrosUsd) || monthlyCapMicrosUsd <= 0) {
    throw new InvalidEnvBudgetValueError("AGENTROUTER_MONTHLY_BUDGET_USD", `micros resultantes invalidos: ${monthlyCapMicrosUsd}`);
  }
  const { monthStartMs, monthEndMs } = computeUtcMonthWindow(nowMs);
  const spentMicrosUsd = getMonthlySpendMicrosUsd(db, { monthStartMs, monthEndMs });
  if (spentMicrosUsd >= monthlyCapMicrosUsd) {
    throw new MonthlyBudgetExhaustedError(spentMicrosUsd, monthlyCapMicrosUsd);
  }
  return { spentMicrosUsd, monthStartMs, monthEndMs };
}

module.exports = {
  EnvBudgetConfigError,
  MissingEnvBudgetError,
  InvalidEnvBudgetValueError,
  IncoherentEnvBudgetError,
  MonthlyBudgetExhaustedError,
  resolveEnvBudgetMicrosUsd,
  buildDailyPolicyOptionsFromMicros,
  computeUtcMonthWindow,
  getMonthlySpendMicrosUsd,
  assertMonthlyBudgetAvailable,
};

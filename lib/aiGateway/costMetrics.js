// Custo real do AI Gateway -- calculado a partir do log de auditoria
// (data/ai-assessments.jsonl, uma linha por chamada a getAssessment()),
// nunca por amostragem/projeção solta.
//
// Duas unidades de contagem, deliberadamente separadas (revisão do usuário,
// 2026-08-11 -- ver git log deste arquivo):
// - "Assessment" = 1 invocação de getAssessment() = 1 linha do log. Um
//   assessment com fallback (Anthropic falha -> OpenAI responde) ainda é
//   1 assessment. Um no_provider_available também é 1 assessment.
// - "Provider attempt" = 1 tentativa contra 1 provider específico dentro de
//   um assessment. O fallback acima é 1 assessment + 2 tentativas (1 falha +
//   1 sucesso); no_provider_available é 1 assessment + 0 tentativas (nunca
//   chegou a discar pra rede).
//
// Sucesso/falha de TENTATIVA (não de assessment) é derivado do controle de
// fluxo real de lib/aiGateway/aiGateway.js::getAssessment(): ele tenta cada
// provider em `order` sequencialmente, registra o nome em `attempted` ANTES
// de chamar, e retorna no primeiro sucesso. Logo: se status==="success", o
// último nome em `attempted` (=== `provider` do registro) venceu e todos os
// outros do array falharam; se status!=="success", todos os nomes em
// `attempted` falharam (nenhum venceu).
//
// Custo/tokens: o esquema atual do log só grava `usage` pro provider
// VENCEDOR de um assessment bem-sucedido -- uma tentativa que falhou nunca
// chega em provider.normalize() (o erro é lançado por dentro de
// callProvider, antes de qualquer parse de resposta), então não existe
// registro de tokens consumidos numa tentativa falha hoje. A regra de soma
// abaixo NÃO discrimina por `status` -- soma qualquer registro que carregue
// um `usage` numérico válido, seja qual for o texto do status. Hoje isso
// converge pra "só sucessos" porque é estruturalmente a única fonte de
// usage que existe, mas o código não assume isso; se o formato do log um
// dia passar a registrar usage de tentativas falhas (ex: erro após resposta
// parcial), a soma já capturaria isso sem mudança nenhuma aqui.
//
// IMPORTANTE (correção de revisão, 2026-08-11): "a tentativa falhou antes de
// normalize()" explica por que NÃO REGISTRAMOS tokens -- não prova que o
// provider não processou/cobrou nada. callProvider() só é chamado depois de
// hasKey() ser true, ou seja, todo nome em `attempted[]` corresponde a uma
// requisição HTTP de verdade que saiu pra rede (diferente de
// no_provider_available, que nunca tenta, `attempted=[]`). Uma tentativa
// que chegou ao provider e falhou (rate limit após processar parte do
// prompt, erro depois de gerar algo, etc.) pode ter custo real que este log
// não consegue enxergar. Por isso TODA tentativa que falhou conta como
// consumo DESCONHECIDO (nunca como R$0 silencioso) -- ver
// AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H abaixo, que por si só já marca
// AI_COST_ESTIMATE_24H como piso (nunca exato) sempre que existir qualquer
// tentativa falha na janela.
//
// Cached/reasoning tokens (2026-08-13, migração pro gpt-5.6-luna): cache é
// SUBCONJUNTO de promptTokens (não soma à parte), cobrado por
// cachedInputPer1M quando o pricing do model documenta isso -- sem preço de
// cache configurado, cache vira entrada normal (nunca inventa desconto).
// reasoningTokens é subconjunto de completionTokens, gasto oculto de
// modelos reasoning (gpt-5.x) -- com reasoning_effort="none" (config atual)
// deveria ficar sempre 0; exposto pra auditoria detectar se algum dia parar
// de ficar.
const fs = require("fs");
const config = require("../../config");

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_24_MS = 24 * MS_PER_HOUR;

function readAssessmentLines(filePath = config.paths.aiAssessmentsLog) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Casa por prefixo, não igualdade exata -- os providers devolvem o model
 * versionado (ex: "gpt-4o-mini-2024-07-18") enquanto config.ai.pricing é
 * declarado pelo nome base (ex: "gpt-4o-mini"). Evita ter que atualizar a
 * tabela de preço toda vez que o provider troca o sufixo de versão.
 */
function resolvePricing(provider, model) {
  const table = config.ai.pricing?.[provider];
  if (!table || !model) return null;
  const key = Object.keys(table).find((k) => model.startsWith(k));
  return key ? table[key] : null;
}

/**
 * cachedTokens (subconjunto de promptTokens, não adicional) é cobrado à
 * parte quando o provider documenta preço de cache (cachedInputPer1M) --
 * sem isso configurado pro par provider/model, cache é cobrado como entrada
 * normal (nunca inventa desconto sem fonte verificada, mesma disciplina do
 * resto do arquivo).
 */
function estimateCostUsd({ provider, model, promptTokens, completionTokens, cachedTokens = 0 }) {
  const pricing = resolvePricing(provider, model);
  if (!pricing || typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  const safeCachedTokens = Math.min(Math.max(0, cachedTokens || 0), promptTokens);
  const nonCachedTokens = promptTokens - safeCachedTokens;
  const cachedRate = typeof pricing.cachedInputPer1M === "number" ? pricing.cachedInputPer1M : pricing.inputPer1M;
  return (nonCachedTokens / 1e6) * pricing.inputPer1M + (safeCachedTokens / 1e6) * cachedRate + (completionTokens / 1e6) * pricing.outputPer1M;
}

/**
 * Único ponto de decisão "esta linha carrega tokens que eu posso somar?" --
 * não olha `status`, só se existe um usage numérico válido associado a um
 * provider conhecido (ver nota de topo do arquivo). cachedTokens/
 * reasoningTokens são opcionais no log (nem todo provider/versão os grava)
 * -- default 0, nunca `null` propagado adiante pra não virar NaN em soma.
 */
function extractUsableUsage(entry) {
  if (!entry.usage || !entry.provider) return null;
  const { promptTokens, completionTokens, cachedTokens, reasoningTokens } = entry.usage;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") return null;
  return {
    provider: entry.provider,
    model: entry.model,
    promptTokens,
    completionTokens,
    cachedTokens: typeof cachedTokens === "number" ? cachedTokens : 0,
    reasoningTokens: typeof reasoningTokens === "number" ? reasoningTokens : 0,
  };
}

function emptyProviderBucket() {
  return {
    attempts: 0,
    successAttempts: 0,
    failedAttempts: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    unpricedAttempts: 0,
    missingUsageAttempts: 0,
  };
}

/**
 * Tally de tentativas por provider a partir de `attempted[]` -- roda pra
 * TODA entrada na janela, independente de status (é exatamente o que
 * permite contar as tentativas que falharam, não só as que venceram).
 */
function tallyAttempts(entry, byProvider) {
  const attempted = entry.attempted || [];
  for (const providerName of attempted) {
    byProvider[providerName] = byProvider[providerName] || emptyProviderBucket();
    byProvider[providerName].attempts += 1;
    const isWinner = entry.status === "success" && providerName === entry.provider;
    if (isWinner) byProvider[providerName].successAttempts += 1;
    else byProvider[providerName].failedAttempts += 1;
  }
}

/**
 * `entries` é injetável (testabilidade, mesmo padrão de
 * lib/backtest.js::run({db,...})) -- por padrão lê o log real.
 * `now`/`windowMs` também injetáveis pra testar a janela sem depender do
 * relógio da máquina.
 */
function computeAiCostMetrics({ now = Date.now(), windowMs = HOURS_24_MS, entries } = {}) {
  const all = entries || readAssessmentLines();
  const windowStart = now - windowMs;
  const inWindow = all.filter((e) => {
    const t = Date.parse(e.time);
    return Number.isFinite(t) && t >= windowStart && t <= now;
  });

  let assessmentsSuccess = 0;
  let assessmentsProviderError = 0;
  let assessmentsNoProvider = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let costUsd = 0;
  let unpricedAttempts = 0;
  let missingUsageAttempts = 0;
  const unpricedModels = new Set();
  const byProvider = {};

  for (const e of inWindow) {
    if (e.status === "success") assessmentsSuccess += 1;
    else if (e.status === "no_provider_available") assessmentsNoProvider += 1;
    else assessmentsProviderError += 1; // provider_error (ou status desconhecido -- não inventa uma 4ª categoria)

    tallyAttempts(e, byProvider);

    const usage = extractUsableUsage(e);
    if (usage) {
      inputTokens += usage.promptTokens;
      cachedInputTokens += usage.cachedTokens;
      outputTokens += usage.completionTokens;
      reasoningTokens += usage.reasoningTokens;
      const bucket = (byProvider[usage.provider] = byProvider[usage.provider] || emptyProviderBucket());
      bucket.inputTokens += usage.promptTokens;
      bucket.cachedInputTokens += usage.cachedTokens;
      bucket.outputTokens += usage.completionTokens;
      bucket.reasoningTokens += usage.reasoningTokens;

      const cost = estimateCostUsd(usage);
      if (cost != null) {
        costUsd += cost;
        bucket.costUsd += cost;
      } else {
        unpricedAttempts += 1;
        bucket.unpricedAttempts += 1;
        // Sempre registra a ocorrência, mesmo sem nome de model -- uma
        // lacuna de preço não pode ficar invisível na lista só porque o
        // provider não devolveu o campo "model" na resposta.
        unpricedModels.add(`${usage.provider}:${usage.model || "<modelo-ausente>"}`);
      }
    } else if (e.status === "success") {
      // Assessment bem-sucedido (deveria ter usage, pelo contrato dos
      // providers) mas o registro não carrega -- gap real, não fabrica tokens.
      missingUsageAttempts += 1;
      const bucket = (byProvider[e.provider || "unknown"] = byProvider[e.provider || "unknown"] || emptyProviderBucket());
      bucket.missingUsageAttempts += 1;
    }
  }

  const providerAttemptsTotal = Object.values(byProvider).reduce((sum, p) => sum + p.attempts, 0);
  const providerAttemptsSuccess = Object.values(byProvider).reduce((sum, p) => sum + p.successAttempts, 0);
  const providerAttemptsFailed = Object.values(byProvider).reduce((sum, p) => sum + p.failedAttempts, 0);

  // Cobertura real do log inteiro (não só da janela) -- se o processo/log só
  // existe há menos que `windowMs`, os números de "24h" acima já são exatos
  // (é tudo que existe), mas ainda não representam um dia cheio de regime de
  // operação -- honestidade pra quem for ler o dashboard não confundir
  // "pouco tempo rodando" com "baixo custo estrutural".
  const allTimes = all.map((e) => Date.parse(e.time)).filter(Number.isFinite);
  const oldestMs = allTimes.length ? Math.min(...allTimes) : null;
  const sampleWindowHours = oldestMs != null ? Math.min(windowMs, now - oldestMs) / MS_PER_HOUR : 0;
  const isFullWindow = oldestMs != null && now - oldestMs >= windowMs;

  return {
    windowHours: windowMs / MS_PER_HOUR,
    sampleWindowHours: Number(sampleWindowHours.toFixed(2)),
    isFullWindow,

    AI_ASSESSMENTS_24H: inWindow.length,
    AI_ASSESSMENTS_24H_SUCCESS: assessmentsSuccess,
    AI_ASSESSMENTS_24H_PROVIDER_ERROR: assessmentsProviderError,
    AI_ASSESSMENTS_24H_NO_PROVIDER: assessmentsNoProvider,

    AI_PROVIDER_ATTEMPTS_24H: providerAttemptsTotal,
    AI_PROVIDER_ATTEMPTS_24H_SUCCESS: providerAttemptsSuccess,
    AI_PROVIDER_ATTEMPTS_24H_FAILED: providerAttemptsFailed,

    AI_INPUT_TOKENS_24H: inputTokens,
    // Subconjunto de AI_INPUT_TOKENS_24H (não adicional) -- quantos desses
    // tokens de entrada vieram do cache do provider, mais baratos.
    AI_CACHED_INPUT_TOKENS_24H: cachedInputTokens,
    AI_OUTPUT_TOKENS_24H: outputTokens,
    // Subconjunto de AI_OUTPUT_TOKENS_24H (não adicional) -- tokens de
    // raciocínio oculto gastos por modelos da família reasoning (gpt-5.x).
    // Com reasoning_effort="none" (config atual) isso deveria ficar 0; expor
    // aqui pra detectar se algum dia deixar de ficar.
    AI_REASONING_TOKENS_24H: reasoningTokens,

    AI_COST_ESTIMATE_24H: Number(costUsd.toFixed(6)),
    // 30D é sempre extrapolação linear a partir da janela de 24h -- nunca
    // 30 dias de dado real (só existiria depois de 30 dias rodando).
    AI_COST_ESTIMATE_30D: Number((costUsd * 30).toFixed(4)),
    // Toda tentativa que chegou à rede e falhou (providerAttemptsFailed) tem
    // consumo de token DESCONHECIDO, não zero -- callProvider() só é
    // chamado depois de hasKey()===true, então "falhou antes de
    // normalize()" explica por que não registramos usage, não prova que o
    // provider não processou/cobrou nada (correção de revisão, 2026-08-11).
    // Por isso entra na mesma condição de "incompleto" que preço
    // desconhecido/usage ausente -- nenhuma tentativa falha pode deixar
    // AI_COST_ESTIMATE_24H parecer exato.
    AI_COST_ESTIMATE_INCOMPLETE: unpricedAttempts > 0 || missingUsageAttempts > 0 || providerAttemptsFailed > 0,
    AI_UNPRICED_ATTEMPTS_24H: unpricedAttempts,
    AI_MISSING_TOKEN_USAGE_24H: missingUsageAttempts,
    // Tentativas que discaram pra rede (estavam em attempted[], então
    // hasKey() era true) e falharam -- consumo real desconhecido, nunca
    // contado como custo zero. Hoje equivale a providerAttemptsFailed
    // (nenhuma tentativa falha tem usage no esquema atual do log), mas é
    // exposto com nome próprio pra deixar a intenção explícita no dashboard/
    // auditoria, em vez de depender de quem lê saber que os dois batem.
    AI_ATTEMPTS_WITH_UNKNOWN_USAGE_24H: providerAttemptsFailed,
    unpricedModels: Array.from(unpricedModels),

    byProvider,
  };
}

module.exports = { computeAiCostMetrics, estimateCostUsd, resolvePricing, extractUsableUsage, readAssessmentLines, HOURS_24_MS };

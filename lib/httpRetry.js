const NETWORK_ERROR_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ECONNABORTED"]);

// Erros de rede transitórios e HTTP 429/5xx são temporários e valem retentar.
// Erros de autenticação/validação (ex: chave inválida, retCode de negócio da Bybit)
// não têm .code nem .response — falham imediato, retentar não resolveria.
function isRetryable(err) {
  if (err && NETWORK_ERROR_CODES.has(err.code)) return true;
  const status = err && err.response && err.response.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return false;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Contagem de retry/429 acumulada desde o boot do processo -- singleton de
// módulo (lib/bybit.js também é chamado como singleton, não instanciado por
// quem chama). Existe pra dar visibilidade real de throttling na Fase A
// (expansão multi-asset): sem isso, um 429 retentado com sucesso fica
// invisível pro collectorMetrics (recordSuccess só vê o resultado final, não
// as tentativas que falharam no meio do caminho).
let totalRetries = 0;
let total429 = 0;
let totalBackoffMs = 0;

function getRetryStats() {
  return { totalRetries, total429, totalBackoffMs };
}

// Só pra isolar estado entre testes -- em produção nunca é chamado (as
// estatísticas devem mesmo acumular pela vida inteira do processo).
function resetRetryStats() {
  totalRetries = 0;
  total429 = 0;
  totalBackoffMs = 0;
}

/**
 * Executa fn() com retry e backoff exponencial. fn é chamada de novo do zero
 * a cada tentativa (importante para chamadas assinadas da Bybit, cujo
 * timestamp/assinatura precisam ser gerados na hora de cada tentativa).
 */
async function withRetry(fn, { retries = 4, baseDelayMs = 1000, maxDelayMs = 30000, sleep = defaultSleep } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      totalRetries++;
      totalBackoffMs += delay;
      if (err?.response?.status === 429) total429++;
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isRetryable, getRetryStats, resetRetryStats };

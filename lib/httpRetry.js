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
      await sleep(delay);
    }
  }
}

module.exports = { withRetry, isRetryable };

const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, isRetryable, getRetryStats, resetRetryStats } = require("../lib/httpRetry");

const noopSleep = () => Promise.resolve();

test("isRetryable: erro de rede transitório é retentável", () => {
  assert.equal(isRetryable({ code: "ENOTFOUND" }), true);
  assert.equal(isRetryable({ code: "ECONNRESET" }), true);
});

test("isRetryable: HTTP 429 e 5xx são retentáveis", () => {
  assert.equal(isRetryable({ response: { status: 429 } }), true);
  assert.equal(isRetryable({ response: { status: 503 } }), true);
});

test("isRetryable: erro de negócio/autenticação (sem code/response) não é retentável", () => {
  assert.equal(isRetryable(new Error("Bybit retCode=10003 API key is invalid")), false);
});

test("isRetryable: HTTP 400 não é retentável", () => {
  assert.equal(isRetryable({ response: { status: 400 } }), false);
});

test("withRetry: sucesso de primeira não retenta", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry: retenta em erro transitório e eventualmente sucede", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("boom");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return "ok";
    },
    { retries: 4, sleep: noopSleep }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry: desiste após o limite de tentativas e propaga o erro", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          const err = new Error("boom");
          err.code = "ECONNRESET";
          throw err;
        },
        { retries: 2, sleep: noopSleep }
      ),
    /boom/
  );
  assert.equal(calls, 3); // tentativa inicial + 2 retries
});

test("withRetry: não retenta erro não-transitório, falha imediato", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("Bybit retCode=10003 API key is invalid");
        },
        { retries: 4, sleep: noopSleep }
      ),
    /API key is invalid/
  );
  assert.equal(calls, 1);
});

// Fase A (expansão multi-asset) -- visibilidade de rate limit/throttling.

test("getRetryStats/resetRetryStats: withRetry acumula totalRetries e totalBackoffMs em qualquer erro retentável", async () => {
  resetRetryStats();
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err = new Error("boom");
        err.code = "ETIMEDOUT";
        throw err;
      }
      return "ok";
    },
    { retries: 4, sleep: noopSleep, baseDelayMs: 100 }
  );

  const stats = getRetryStats();
  assert.equal(stats.totalRetries, 2);
  assert.equal(stats.total429, 0, "ETIMEDOUT não é rate limit");
  assert.ok(stats.totalBackoffMs > 0);
  resetRetryStats();
});

test("getRetryStats: distingue 429 (rate limit) de outros erros retentáveis", async () => {
  resetRetryStats();
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 2) {
        const err = new Error("too many requests");
        err.response = { status: 429 };
        throw err;
      }
      return "ok";
    },
    { retries: 4, sleep: noopSleep, baseDelayMs: 10 }
  );

  const stats = getRetryStats();
  assert.equal(stats.totalRetries, 1);
  assert.equal(stats.total429, 1);
  resetRetryStats();
});

test("resetRetryStats: zera os contadores", async () => {
  resetRetryStats();
  await assert.rejects(() =>
    withRetry(
      async () => {
        const err = new Error("boom");
        err.code = "ECONNRESET";
        throw err;
      },
      { retries: 1, sleep: noopSleep }
    )
  );
  assert.ok(getRetryStats().totalRetries > 0);
  resetRetryStats();
  assert.deepEqual(getRetryStats(), { totalRetries: 0, total429: 0, totalBackoffMs: 0 });
});

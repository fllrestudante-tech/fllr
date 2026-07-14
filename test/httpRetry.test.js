const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, isRetryable } = require("../lib/httpRetry");

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

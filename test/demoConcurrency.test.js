// Prova de exclusão mútua REAL entre PROCESSOS distintos (Bloqueador 5) --
// nunca Promise.all dentro do mesmo processo (isso só prova exclusão
// intra-processo, já coberta em test/demoOrderGate.test.js). Aqui dois
// `node` de verdade (child_process.spawn) competem pelo MESMO lock de
// reserva (lib/demoReservationLock.js, via fs.openSync(path,"wx")) sobre
// um runtime TEMPORÁRIO isolado (CRYPTO10_DEMO_RUNTIME_DIR) -- nunca o
// runtime/demo/ operacional real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const WORKER_PATH = path.join(__dirname, "helpers", "demoConcurrencyWorker.js");

function runWorker(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
        resolve({ code, result: JSON.parse(lastLine), stderr });
      } catch (err) {
        reject(new Error(`worker não produziu JSON válido (code=${code}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}): ${err.message}`));
      }
    });
  });
}

function baseEnv(runtimeDir) {
  return {
    ...process.env,
    CRYPTO10_TEST_WORKER: "1", // variável exclusiva exigida por lib/demoRuntimePaths.js pra aceitar o override abaixo (item 4 da Rodada 4)
    CRYPTO10_DEMO_RUNTIME_DIR: runtimeDir,
    SUPERVISOR_PROFILE: "demo",
    BYBIT_DEMO: "true",
    BYBIT_TESTNET: "false",
    BYBIT_API_KEY: "fake-key-not-a-real-secret",
    BYBIT_API_SECRET: "fake-secret-not-real",
    DEMO_ORDER_COOLDOWN_MS: "999999999", // bem maior que a duração do teste -- só o SEGUNDO processo a passar pelo lock deveria ver isso e ser bloqueado
  };
}

test("subprocessos reais: dois `node` distintos disputando o MESMO lock de reserva -- só um reserva a capacidade financeira (cooldown), nunca os dois", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-demo-concurrency-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

  const env = baseEnv(runtimeDir);
  const idA = `demo-${crypto.randomUUID()}`;
  const idB = `demo-${crypto.randomUUID()}`;

  await runWorker(["setup"], env); // arma o kill switch + grava o snapshot UMA vez, antes da corrida real
  const [resA, resB] = await Promise.all([runWorker(["race", idA], env), runWorker(["race", idB], env)]);

  assert.equal(resA.code, 0, `worker A não deveria crashar: ${resA.stderr}`);
  assert.equal(resB.code, 0, `worker B não deveria crashar: ${resB.stderr}`);

  const results = [resA.result, resB.result];
  const allowed = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);

  assert.equal(allowed.length, 1, `exatamente 1 dos 2 processos deveria ter reservado a capacidade -- resultados: ${JSON.stringify(results)}`);
  assert.equal(blocked.length, 1);
  assert.equal(allowed[0].kind, "INCREASE_EXPOSURE");
  // O processo bloqueado precisa ter sido bloqueado por VER a reserva do
  // outro (cooldown_active) -- nunca por um motivo não relacionado (o que
  // indicaria que os dois processos nunca chegaram a competir de verdade
  // pelo mesmo estado compartilhado).
  assert.equal(blocked[0].code, "DEMO_RISK_LIMIT_BLOCKED");
  assert.equal(blocked[0].reason, "cooldown_active");

  // Confirma que o lock foi de fato liberado ao final (nunca fica órfão).
  const lockPath = path.join(runtimeDir, "reservation.lock");
  assert.equal(fs.existsSync(lockPath), false, "lock de reserva nunca deveria sobreviver ao fim de ambos os processos");
});

test("subprocessos reais: mesmo orderLinkId disparado por dois processos distintos -- só um grava a reserva, o outro é rejeitado por reuso (idempotência cross-process)", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-demo-concurrency-dup-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));

  const env = baseEnv(runtimeDir);
  const sharedId = `demo-${crypto.randomUUID()}`;

  await runWorker(["setup"], env);
  const [resA, resB] = await Promise.all([runWorker(["race", sharedId], env), runWorker(["race", sharedId], env)]);
  const results = [resA.result, resB.result];
  const allowed = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);

  assert.equal(allowed.length, 1, `exatamente 1 dos 2 processos deveria ter sido aceito -- resultados: ${JSON.stringify(results)}`);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].code, "DEMO_ORDER_LINK_ID_REUSED");
});

test("subprocessos reais: nenhum resíduo fica em runtime/demo/ operacional real -- tudo isolado em CRYPTO10_DEMO_RUNTIME_DIR", async () => {
  const realRuntimeDemoDir = path.join(__dirname, "..", "runtime", "demo");
  const before = fs.existsSync(realRuntimeDemoDir) ? new Set(fs.readdirSync(realRuntimeDemoDir)) : new Set();

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-demo-concurrency-residue-"));
  const env = baseEnv(runtimeDir);
  await runWorker(["setup"], env);
  await runWorker(["race", `demo-${crypto.randomUUID()}`], env);
  fs.rmSync(runtimeDir, { recursive: true, force: true });

  const after = fs.existsSync(realRuntimeDemoDir) ? new Set(fs.readdirSync(realRuntimeDemoDir)) : new Set();
  assert.deepEqual([...after].sort(), [...before].sort(), "o worker nunca deveria ter criado/alterado arquivos em runtime/demo/ real");
});

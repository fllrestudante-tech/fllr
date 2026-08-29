// Prova via SUBPROCESSO REAL (node index.js) que o gate de perfil no topo
// do arquivo bloqueia ANTES de requerer lib/bybit.js -- portanto antes de
// qualquer HMAC/Axios. Nunca inicia o loop de verdade: todo caso aqui é
// uma configuração que DEVE bloquear; o único jeito de confirmar "nenhuma
// chamada de rede aconteceu" sem mockar rede dentro de um processo
// separado é a saída ser praticamente instantânea (uma chamada HTTP real,
// mesmo que falhe, nunca é tão rápida quanto um `process.exit(1)` síncrono
// logo na primeira linha) -- por isso o teto de tempo abaixo é generoso o
// bastante pra não ser flaky, mas MUITO menor que qualquer round-trip de
// rede real ou timeout de DNS.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");

const INDEX_JS_PATH = path.join(__dirname, "..", "index.js");
const MAX_BLOCKED_EXIT_MS = 3000;

// Limpa explicitamente TODAS as variáveis relevantes antes de aplicar
// envOverrides -- outros arquivos deste mesmo processo de teste (quando a
// suíte roda completa, node --test compartilha o processo) podem já ter
// requerido config.js, cujo dotenv.config() só preenche process.env vars
// AINDA não definidas -- se o .env real deste repositório tiver
// BYBIT_API_KEY/BYBIT_DEMO preenchidos, eles teriam vazado por herança
// pro subprocesso sem esta limpeza, mascarando exatamente os casos de
// "credencial ausente"/"flag ausente" que estes testes existem pra provar.
const ENV_KEYS_TO_ISOLATE = ["SUPERVISOR_PROFILE", "BYBIT_DEMO", "BYBIT_TESTNET", "BYBIT_API_KEY", "BYBIT_API_SECRET"];

function runIndexJs(envOverrides) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const env = { ...process.env };
    for (const key of ENV_KEYS_TO_ISOLATE) delete env[key];
    Object.assign(env, envOverrides);
    const child = spawn(process.execPath, [INDEX_JS_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`index.js não encerrou dentro de ${MAX_BLOCKED_EXIT_MS}ms -- possível chamada de rede real não bloqueada`));
    }, MAX_BLOCKED_EXIT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - start });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function baseBlockedEnv(overrides = {}) {
  // NUNCA inclui SUPERVISOR_PROFILE=demo válido nesta função -- todo teste
  // deste arquivo é um caso que DEVE bloquear. ENV_KEYS_TO_ISOLATE já
  // garante que nenhuma das 5 variáveis sensíveis vaza do processo pai.
  return {
    NODE_ENV: "test",
    ...overrides,
  };
}

test("index.js: SUPERVISOR_PROFILE ausente -> bloqueia rápido, código 1, nenhuma chamada de rede", async () => {
  const result = await runIndexJs(baseBlockedEnv());
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("BLOQUEADO"), `stderr deveria mencionar BLOQUEADO: ${result.stderr}`);
  assert.ok(result.elapsedMs < MAX_BLOCKED_EXIT_MS);
});

test("index.js: SUPERVISOR_PROFILE=safe -> bloqueia (bot nunca roda no perfil safe, nem invocado diretamente)", async () => {
  const result = await runIndexJs(baseBlockedEnv({ SUPERVISOR_PROFILE: "safe" }));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("BLOQUEADO"));
  assert.ok(result.stderr.includes("demo"), "mensagem deveria nomear o perfil exigido");
});

test("index.js: SUPERVISOR_PROFILE=demo mas BYBIT_DEMO ausente -> bloqueia com DEMO_FLAG_INVALID", async () => {
  const result = await runIndexJs(
    baseBlockedEnv({
      SUPERVISOR_PROFILE: "demo",
      BYBIT_TESTNET: "false",
      BYBIT_API_KEY: "fake-key-not-a-real-secret",
      BYBIT_API_SECRET: "fake-secret-not-real",
    })
  );
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("DEMO_FLAG_INVALID"));
});

test("index.js: SUPERVISOR_PROFILE=demo, BYBIT_DEMO=true, mas BYBIT_TESTNET='true' -> bloqueia (testnet privado estruturalmente impossível)", async () => {
  const result = await runIndexJs(
    baseBlockedEnv({
      SUPERVISOR_PROFILE: "demo",
      BYBIT_DEMO: "true",
      BYBIT_TESTNET: "true",
      BYBIT_API_KEY: "fake-key-not-a-real-secret",
      BYBIT_API_SECRET: "fake-secret-not-real",
    })
  );
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("DEMO_FLAG_INVALID"));
});

test("index.js: SUPERVISOR_PROFILE=demo, flags corretas, mas sem credenciais -> bloqueia com DEMO_CREDENTIALS_MISSING", async () => {
  const result = await runIndexJs(
    baseBlockedEnv({
      SUPERVISOR_PROFILE: "demo",
      BYBIT_DEMO: "true",
      BYBIT_TESTNET: "false",
    })
  );
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("DEMO_CREDENTIALS_MISSING"));
});

test("index.js: perfil totalmente desconhecido -> bloqueia com SUPERVISOR_PROFILE_INVALID, nunca chega a checar Bybit", async () => {
  const result = await runIndexJs(baseBlockedEnv({ SUPERVISOR_PROFILE: "producao-tudo-ligado" }));
  assert.equal(result.code, 1);
  assert.ok(result.stderr.includes("BLOQUEADO"));
});

test("index.js: nenhum dos casos acima produz stdout/stderr contendo o valor das credenciais fake usadas no teste", async () => {
  const secretKey = "segredo-fake-key-index-nao-deve-aparecer";
  const result = await runIndexJs(
    baseBlockedEnv({
      SUPERVISOR_PROFILE: "demo",
      BYBIT_DEMO: "nope",
      BYBIT_API_KEY: secretKey,
    })
  );
  assert.ok(!result.stdout.includes(secretKey));
  assert.ok(!result.stderr.includes(secretKey));
});

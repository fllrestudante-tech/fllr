// Diretório onde o estado operacional do perfil demo vive
// (kill-switch.json, order-ledger.json, private-call-outcomes.json,
// account-snapshot.json, locks).
//
// CRYPTO10_DEMO_RUNTIME_DIR NUNCA é aceito só por estar presente no env
// -- isso permitiria que um `.env` de produção malconfigurado (ou um
// ataque de injeção de env) redirecionasse todo o estado financeiro do
// perfil demo pra um diretório arbitrário, escondendo/forjando
// kill-switch, ledger e snapshot. É aceito SOMENTE quando as TRÊS
// condições abaixo são verdadeiras ao mesmo tempo:
//   1. CRYPTO10_TEST_WORKER==="1" -- variável EXCLUSIVA de teste, nunca
//      documentada em .env.example, nunca definida por config.js/dotenv,
//      só setada explicitamente pelo processo que faz spawn do worker de
//      teste (ver test/demoConcurrency.test.js).
//   2. O diretório pedido está DENTRO de os.tmpdir() -- nunca em
//      qualquer outro lugar do disco, inclusive nunca dentro do próprio
//      repositório.
//   3. O diretório pedido não é (e não resolve pra) o runtime/demo
//      operacional real deste projeto.
// Fora dessas condições, LANÇA imediatamente (fail-closed, alto e
// visível) em vez de silenciosamente ignorar o override e seguir com o
// caminho default -- um valor rejeitado deveria travar o processo, não
// mascarar o erro de configuração.
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_WORKER_ENV = "CRYPTO10_TEST_WORKER";
const OPERATIONAL_DIR = path.join(__dirname, "..", "runtime", "demo");

class DemoRuntimeDirRejectedError extends Error {
  constructor(detail) {
    super(`CRYPTO10_DEMO_RUNTIME_DIR rejeitado: ${detail} -- nunca usado para redirecionar estado financeiro fora de um worker de teste explicitamente identificado.`);
    this.name = this.constructor.name;
    this.code = "DEMO_RUNTIME_DIR_REJECTED";
  }
}

function demoRuntimeDir(env = process.env) {
  const override = env.CRYPTO10_DEMO_RUNTIME_DIR;
  if (override === undefined || override === "") return OPERATIONAL_DIR;

  if (env[TEST_WORKER_ENV] !== "1") {
    throw new DemoRuntimeDirRejectedError(`${TEST_WORKER_ENV}="1" precisa estar explicitamente definido no mesmo processo`);
  }

  // Comparação de caminho case-insensitive no Windows (NTFS não distingue
  // maiúsculas/minúsculas) -- nunca deixa um valor escapar da checagem só
  // por diferença de capitalização de drive/pasta.
  const normalize = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

  const resolvedOverride = path.resolve(override);
  const resolvedTmp = path.resolve(fs.realpathSync(os.tmpdir()));
  const withinTmp = normalize(resolvedOverride) === normalize(resolvedTmp) || normalize(resolvedOverride).startsWith(normalize(resolvedTmp) + path.sep);
  if (!withinTmp) {
    throw new DemoRuntimeDirRejectedError(`precisa estar dentro de os.tmpdir() (${resolvedTmp}) -- valor pedido: ${resolvedOverride}`);
  }

  const resolvedOperational = path.resolve(OPERATIONAL_DIR);
  if (normalize(resolvedOverride) === normalize(resolvedOperational)) {
    throw new DemoRuntimeDirRejectedError("não pode apontar pro runtime/demo operacional real");
  }

  return resolvedOverride;
}

module.exports = { demoRuntimeDir, DemoRuntimeDirRejectedError, TEST_WORKER_ENV, OPERATIONAL_DIR };

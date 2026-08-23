// Orquestrador do transporte AgentRouter -- spawna o Codex CLI oficial como
// subprocesso (única via comprovadamente autenticada, ver spike read-only
// desta sessão), extrai resultado via lib/agentrouterCli/jsonlParser.js.
//
// Garantias reais: um subprocesso Codex por chamada, zero retry de
// transporte configurado, nenhuma segunda invocação criada pelo Crypto10.
// NÃO garante "uma requisição HTTP" -- o próprio Codex pode fazer múltiplos
// turnos upstream (Teste C real: 1 invocação -> 5 chamadas no painel). Ver
// meta.invocationNote.
//
// Windows: `spawn(bare, {shell:false})` nunca resolve o shim `codex.cmd`
// que `npm install -g` cria (comprovado: 'error' ENOENT pro nome bare,
// exceção SÍNCRONA EINVAL pro .cmd explícito). validateCodexCommand()
// rejeita .cmd/.bat -- operação correta exige AGENTROUTER_CODEX_COMMAND
// apontando pro codex.exe real (comprovado: spawn direto do .exe funciona).
const { spawn: nodeSpawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createJsonlParser } = require("./agentrouterCli/jsonlParser");
const { getAgentRouterAssessmentSchema } = require("./agentrouterCli/outputSchema");

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const MAX_PROMPT_BYTES = 100_000;
const WORKDIR_PREFIX = "crypto10-agentrouter-";
const CODEX_COMMAND_MAX_LENGTH = 260;
const MODEL_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

// Nomes canônicos -- lookup contra o env de origem é case-insensitive
// (Windows frequentemente expõe Path/SystemRoot/ComSpec, não PATH/
// SYSTEMROOT/COMSPEC), mas o env do filho sempre recebe a grafia canônica
// abaixo. CODEX_HOME só entra se já existir no env de origem -- nunca
// fabricado aqui (a config real mora em ~/.codex/config.toml).
const ENV_ALLOWLIST = ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "CODEX_HOME"];

function createAgentRouterError(code, message, meta) {
  const err = new Error(message);
  err.code = code;
  if (meta) err.meta = meta;
  return err;
}

// Só copia valores que já são string -- um env injetado com valor não-string
// nunca deve chegar em spawn() pra sofrer coerção implícita.
function buildMinimalEnv(sourceEnv) {
  const lowerToActualKey = new Map();
  if (sourceEnv) {
    for (const key of Object.keys(sourceEnv)) lowerToActualKey.set(key.toLowerCase(), key);
  }
  const env = {};
  for (const canonicalKey of ENV_ALLOWLIST) {
    const actualKey = lowerToActualKey.get(canonicalKey.toLowerCase());
    if (actualKey === undefined) continue;
    const value = sourceEnv[actualKey];
    if (typeof value === "string") env[canonicalKey] = value;
  }
  return env;
}

function validateCodexCommand(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > CODEX_COMMAND_MAX_LENGTH) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "invalid codexCommand: empty or exceeds max length");
  }
  if (/[\x00\r\n]/.test(value)) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "invalid codexCommand: contains NUL/CR/LF");
  }
  const lower = value.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    throw createAgentRouterError(
      "AGENTROUTER_SPAWN_ERROR",
      "codexCommand must not be a .cmd/.bat shim -- not directly spawnable without a shell; point AGENTROUTER_CODEX_COMMAND at the real codex executable"
    );
  }
  const hasPathSeparator = value.includes("/") || value.includes("\\");
  if (!hasPathSeparator) {
    if (/\s/.test(value)) {
      throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "invalid codexCommand: bare executable name must not contain whitespace");
    }
    return;
  }
  if (!path.isAbsolute(value)) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "invalid codexCommand: path form must be absolute");
  }
}

function validateModel(model) {
  if (model === null || model === undefined) return null;
  if (typeof model !== "string" || !MODEL_TOKEN_PATTERN.test(model)) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "invalid model: must be a short technical token");
  }
  return model;
}

// Não-vazio (e não só espaço em branco) importa especialmente pro `system`
// -- é ele que carrega as restrições de segurança (sem ferramentas, sem
// execução, tratar contexto como não confiável); um system em branco seria
// um Codex sem nenhuma das proteções que promptBuilderEnglish.js constrói.
// trim() é usado SÓ pra validar -- o valor original (com espaços/quebras
// que o chamador tenha colocado de propósito) é preservado byte a byte no
// prompt de verdade.
function validatePromptText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", `invalid ${label}: must be a non-empty string`);
  }
  if (value.includes("\x00")) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", `invalid ${label}: contains NUL`);
  }
}

function validatePositiveInteger(value, { min, max }, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", `invalid ${label}: must be an integer between ${min} and ${max}`);
  }
  return value;
}

// Fronteira inequívoca entre instrução e dado não confiável -- o Codex CLI
// recebe tudo como um único blob via stdin (não como messages[] estruturado).
function buildFullPrompt(system, user) {
  return `[SYSTEM INSTRUCTIONS]\n${system}\n\n[UNTRUSTED MARKET CONTEXT]\n${user}`;
}

function buildCodexArgs({ workDir, schemaPath, model }) {
  const args = [
    "exec",
    "-C", workDir,
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--json",
    "--output-schema", schemaPath,
    // já é `false` por padrão (confirmado via `codex features list`) --
    // explícito por defesa em profundidade. `--ask-for-approval` foi
    // removido (2026-08-15): não pertence ao subcomando `exec` nesta
    // versão do Codex CLI (ausente de `codex exec --help`, só existe no
    // nível raiz/TUI interativo) -- causava saída imediata com código
    // não-zero antes de qualquer chamada de rede (comprovado: falha em
    // 43ms, AGENTROUTER_EXIT_NONZERO, zero usage). `exec` já roda
    // inerentemente sem sessão interativa, então não há aprovação pra
    // configurar aqui.
    "--disable", "standalone_web_search",
    "-c", "request_max_retries=0",
    "-c", "stream_max_retries=0",
  ];
  if (model) args.push("--model", model);
  args.push("-"); // força leitura do prompt via stdin, nunca como argumento
  return args;
}

/**
 * Assíncrono de propósito -- execFileSync bloquearia o event loop do bot
 * inteiro (loop de trading roda a cada 10s). Sempre resolve (nunca rejeita)
 * -- é best-effort por natureza.
 */
function defaultKillProcessTree(child) {
  return new Promise((resolve) => {
    const finishWithDirectKill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // processo já pode ter morrido -- ignora
      }
      resolve();
    };
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, finishWithDirectKill);
      return;
    }
    finishWithDirectKill();
  });
}

/** killFn injetado pode lançar síncrono ou devolver Promise rejeitada -- nenhum dos dois pode propagar. */
function protectedKill(killFn, child) {
  try {
    Promise.resolve(killFn(child)).catch(() => {});
  } catch {
    // ignora -- best-effort
  }
}

function safeInvokeCleanupError(onCleanupError, payload) {
  try {
    const maybePromise = onCleanupError(payload);
    if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
  } catch {
    // callback injetado nunca pode derrubar o processo
  }
}

/**
 * Exige o PAI exato (mesma raiz usada na criação, via tmpdirFn) e o
 * basename com o prefixo -- só checar o basename permitiria apagar
 * qualquer diretório chamado "crypto10-agentrouter-*" em qualquer lugar.
 */
function isSafeWorkDir(workDir, tmpdirFn) {
  const resolved = path.resolve(workDir);
  const expectedParent = path.resolve(tmpdirFn());
  const basename = path.basename(resolved);
  return path.dirname(resolved) === expectedParent && basename.startsWith(WORKDIR_PREFIX) && basename !== WORKDIR_PREFIX;
}

// Tudo dentro de um único try -- tmpdirFn()/isSafeWorkDir() também podem
// lançar (ex: tmpdirFn injetado quebrado), e essa função nunca pode devolver
// uma Promise rejeitada pro chamador.
async function cleanupWorkDir({ workDir, rmFn, onCleanupError, tmpdirFn }) {
  try {
    if (!workDir) return;
    if (!isSafeWorkDir(workDir, tmpdirFn)) {
      safeInvokeCleanupError(onCleanupError, { code: "AGENTROUTER_CLEANUP_SKIPPED_UNSAFE_PATH" });
      return;
    }
    await rmFn(workDir, { recursive: true, force: true });
  } catch {
    safeInvokeCleanupError(onCleanupError, { code: "AGENTROUTER_CLEANUP_FAILED" });
  }
}

// Single-flight GLOBAL de processo -- não por instância.
let activeRun = false;

async function runAgentRouterPrompt(options = {}) {
  const {
    system,
    user,
    model = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    gracefulShutdownMs = DEFAULT_GRACEFUL_SHUTDOWN_MS,
    maxPromptBytes = MAX_PROMPT_BYTES,
    codexCommand = process.env.AGENTROUTER_CODEX_COMMAND || "codex",
    spawn = nodeSpawn,
    killProcessTree = defaultKillProcessTree,
    env = process.env,
    onCleanupError = () => {},
    mkdtempFn = fs.mkdtempSync,
    writeFileFn = fs.writeFileSync,
    rmFn = fsPromises.rm,
    tmpdirFn = os.tmpdir,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = Date.now,
  } = options;

  if (activeRun) {
    throw createAgentRouterError("AGENTROUTER_BUSY", "AgentRouter subprocess already in flight for this process");
  }

  // Validação síncrona -- antes de tocar disco/processo, antes de travar o lock.
  validateCodexCommand(codexCommand);
  const safeModel = validateModel(model);
  validatePromptText(system, "system");
  validatePromptText(user, "user");
  const safeTimeoutMs = validatePositiveInteger(timeoutMs, { min: 1_000, max: 600_000 }, "timeoutMs");
  const safeGracefulShutdownMs = validatePositiveInteger(gracefulShutdownMs, { min: 100, max: 60_000 }, "gracefulShutdownMs");
  const safeMaxPromptBytes = validatePositiveInteger(maxPromptBytes, { min: 1, max: 10_000_000 }, "maxPromptBytes");

  const fullPrompt = buildFullPrompt(system, user);
  const promptBytes = Buffer.byteLength(fullPrompt, "utf8");
  if (promptBytes > safeMaxPromptBytes) {
    throw createAgentRouterError("AGENTROUTER_SPAWN_ERROR", `combined prompt exceeds max size (${safeMaxPromptBytes} bytes)`);
  }

  activeRun = true;
  const startedAt = nowFn();

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let cleanedUp = false;
    let abortReason = null; // null | "timeout" | "process_error"
    let timedOut = false;
    let processError = false;
    let stdinError = false;
    let parserFailure = false;

    let workDir = null;
    let child = null;
    let timeoutTimer = null;
    let graceTimer = null;
    const parser = createJsonlParser();
    let stderrByteLength = 0;

    function resolveOnce(value) {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    }
    function rejectOnce(err) {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    }
    function cleanupOnce() {
      if (cleanedUp) return;
      cleanedUp = true;
      activeRun = false;
      Promise.resolve(cleanupWorkDir({ workDir, rmFn, onCleanupError, tmpdirFn })).catch(() => {});
    }
    function baseMeta(extra) {
      return {
        transport: "codex_cli",
        invocationNote: "one Codex invocation per assessment, zero transport retries",
        modelRequested: safeModel,
        modelEffective: null,
        pid: child?.pid ?? null,
        durationMs: nowFn() - startedAt,
        stderrByteLength,
        stdinError,
        timedOut,
        processError,
        ...extra,
      };
    }
    function beginAbortSequence(reason) {
      if (settled || abortReason) return;
      abortReason = reason;
      protectedKill(killProcessTree, child);
      graceTimer = setTimeoutFn(() => {
        if (settled) return;
        const err =
          reason === "timeout"
            ? createAgentRouterError(
                "AGENTROUTER_TIMEOUT",
                "AgentRouter subprocess did not confirm termination within grace period; provider left locked until it does (or process restart)",
                baseMeta({ closeConfirmed: false })
              )
            : createAgentRouterError(
                "AGENTROUTER_SPAWN_ERROR",
                "codex process reported an error after starting and did not confirm termination within grace period; provider left locked until it does (or process restart)",
                baseMeta({ closeConfirmed: false })
              );
        rejectOnce(err);
      }, safeGracefulShutdownMs);
    }

    try {
      workDir = mkdtempFn(path.join(tmpdirFn(), WORKDIR_PREFIX));
      const schemaPath = path.join(workDir, "schema.json");
      writeFileFn(schemaPath, JSON.stringify(getAgentRouterAssessmentSchema()), { encoding: "utf8", mode: 0o600, flag: "wx" });

      const args = buildCodexArgs({ workDir, schemaPath, model: safeModel });
      const minimalEnv = buildMinimalEnv(env);

      try {
        child = spawn(codexCommand, args, {
          cwd: workDir,
          shell: false,
          windowsHide: true,
          env: minimalEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        cleanupOnce();
        rejectOnce(createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "failed to spawn codex process", baseMeta({ closeConfirmed: false })));
        return;
      }

      child.on("error", () => {
        if (settled) return;
        if (!child.pid) {
          if (timeoutTimer) clearTimeoutFn(timeoutTimer);
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "codex process failed to spawn", baseMeta({ closeConfirmed: false })));
          return;
        }
        processError = true;
        if (timeoutTimer) clearTimeoutFn(timeoutTimer);
        beginAbortSequence("process_error");
      });

      // Registrado logo após 'error' -- minimiza a janela em que uma
      // exceção síncrona no restante do setup (capturada pelo catch
      // externo) precisaria abortar um filho com PID vivo sem sequer ter
      // um listener de 'close' pra confirmar o encerramento depois.
      child.on("close", (code, signal) => {
        if (timeoutTimer) clearTimeoutFn(timeoutTimer);
        if (graceTimer) clearTimeoutFn(graceTimer);
        try {
          parser.flush();
        } catch {
          parserFailure = true;
        }

        if (settled) {
          cleanupOnce();
          return;
        }

        const parserResult = parser.getResult();
        const meta = baseMeta({
          exitCode: code,
          signal,
          closeConfirmed: true,
          eventCount: parserResult.eventCount,
          eventTypeCounts: parserResult.eventTypeCounts,
        });

        if (timedOut) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_TIMEOUT", "AgentRouter subprocess was killed after exceeding timeout", meta));
          return;
        }
        if (processError) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "codex process reported an error after starting", meta));
          return;
        }
        if (stdinError) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_STDIN_ERROR", "failed to write the full prompt to the codex process stdin", meta));
          return;
        }
        if (parserFailure) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_STREAM_INVALID", "jsonl parser raised an exception while processing codex output", meta));
          return;
        }
        if (code !== 0) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_EXIT_NONZERO", "codex process exited with a non-zero code", meta));
          return;
        }
        if (parserResult.errorCount > 0 || parserResult.overflow) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_STREAM_INVALID", "codex JSONL stream was invalid or exceeded safety limits", meta));
          return;
        }
        if (!parserResult.complete) {
          cleanupOnce();
          rejectOnce(createAgentRouterError("AGENTROUTER_RESPONSE_INCOMPLETE", "codex process closed without producing a complete assessment", meta));
          return;
        }

        cleanupOnce();
        resolveOnce({ text: parserResult.text, usage: parserResult.usage, threadId: parserResult.threadId, meta });
      });

      child.stdout.on("data", (chunk) => {
        try {
          parser.push(chunk);
        } catch {
          parserFailure = true;
        }
      });

      child.stderr.on("data", (chunk) => {
        try {
          stderrByteLength += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        } catch {
          // só contagem -- nunca crítico
        }
      });

      child.stdin.on("error", () => {
        stdinError = true;
      });
      child.stdin.end(fullPrompt, "utf8", (err) => {
        if (err) stdinError = true;
      });

      timeoutTimer = setTimeoutFn(() => {
        if (settled || abortReason) return;
        timedOut = true;
        beginAbortSequence("timeout");
      }, safeTimeoutMs);
    } catch {
      // Exceção síncrona em qualquer parte do setup acima. Se o filho já
      // tem PID, ele está vivo -- mesmo protocolo do timeout (kill + espera
      // por close + lock preso se não confirmar), nunca libera direto.
      if (child?.pid) {
        processError = true;
        beginAbortSequence("process_error");
        return;
      }
      cleanupOnce();
      rejectOnce(createAgentRouterError("AGENTROUTER_SPAWN_ERROR", "unexpected error while preparing codex invocation", baseMeta({ closeConfirmed: false })));
    }
  });
}

module.exports = {
  runAgentRouterPrompt,
  createAgentRouterError,
  validateCodexCommand,
  validateModel,
  validatePromptText,
  validatePositiveInteger,
  buildFullPrompt,
  buildMinimalEnv,
  buildCodexArgs,
  defaultKillProcessTree,
  cleanupWorkDir,
  isSafeWorkDir,
  ENV_ALLOWLIST,
  MAX_PROMPT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_GRACEFUL_SHUTDOWN_MS,
  WORKDIR_PREFIX,
};

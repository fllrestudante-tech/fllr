const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const {
  runAgentRouterPrompt,
  validateCodexCommand,
  validateModel,
  validatePromptText,
  validatePositiveInteger,
  buildFullPrompt,
  buildMinimalEnv,
  buildCodexArgs,
  cleanupWorkDir,
  isSafeWorkDir,
  WORKDIR_PREFIX,
} = require("../lib/agentrouterClient");

// Rede de segurança pra toda a suíte: nenhum caminho do client pode deixar
// uma Promise rejeitada sem handler escapar (killProcessTree/onCleanupError
// protegidos, etc.) -- checado no fim do arquivo.
const unhandledRejections = [];
process.on("unhandledRejection", (reason) => unhandledRejections.push(reason));

// --- Helpers de teste ---

function createManualClock() {
  let idCounter = 0;
  const pending = new Map();
  function fakeSetTimeout(fn) {
    const id = ++idCounter;
    pending.set(id, fn);
    return id;
  }
  function fakeClearTimeout(id) {
    pending.delete(id);
  }
  function fire(id) {
    const fn = pending.get(id);
    if (fn) {
      pending.delete(id);
      fn();
    }
  }
  function fireOldest() {
    const [id] = [...pending.keys()];
    if (id !== undefined) fire(id);
  }
  return { fakeSetTimeout, fakeClearTimeout, fire, fireOldest, pendingCount: () => pending.size };
}

function createFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.endError = null;
  child.stdin.end = (data, encoding, callback) => {
    const cb = typeof encoding === "function" ? encoding : callback;
    child.stdin.writes.push(data);
    if (cb) cb(child.stdin.endError || undefined);
  };
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

const SUCCESS_EVENTS = [
  { type: "thread.started", thread_id: "thread-abc" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: '{"bias":"neutral"}' } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } },
];
const SUCCESS_JSONL = SUCCESS_EVENTS.map((e) => JSON.stringify(e) + "\n").join("");

function emitSuccessAndClose(child, { code = 0 } = {}) {
  child.stdout.emit("data", Buffer.from(SUCCESS_JSONL, "utf8"));
  child.emit("close", code, null);
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeFs({ mkdtempPath = "/fake/tmp/" + WORKDIR_PREFIX + "xyz" } = {}) {
  const rmCalls = [];
  return {
    mkdtempFn: () => mkdtempPath,
    writeFileFn: () => {},
    rmFn: async (dir, opts) => {
      rmCalls.push({ dir, opts });
    },
    tmpdirFn: () => "/fake/tmp",
    rmCalls,
  };
}

function baseOptions(overrides = {}) {
  return {
    system: "system instructions",
    user: "untrusted context",
    ...fakeFs(),
    ...overrides,
  };
}

// ============================================================
// Funções puras
// ============================================================

test("validateCodexCommand: rejeita .cmd/.bat (bare e absoluto)", () => {
  assert.throws(() => validateCodexCommand("codex.cmd"), /\.cmd\/\.bat/);
  assert.throws(() => validateCodexCommand("C:\\tools\\codex.bat"), /\.cmd\/\.bat/);
});

test("validateCodexCommand: rejeita NUL/CR/LF", () => {
  assert.throws(() => validateCodexCommand("codex\x00"));
  assert.throws(() => validateCodexCommand("codex\r\n"));
});

test("validateCodexCommand: nome simples com espaço é rejeitado", () => {
  assert.throws(() => validateCodexCommand("codex extra"));
});

test("validateCodexCommand: caminho com separador mas relativo é rejeitado", () => {
  assert.throws(() => validateCodexCommand("./codex.exe"));
  assert.throws(() => validateCodexCommand("../codex.exe"));
});

test("validateCodexCommand: aceita nome simples e caminho absoluto com espaço", () => {
  assert.doesNotThrow(() => validateCodexCommand("codex"));
  assert.doesNotThrow(() => validateCodexCommand("codex.exe"));
  assert.doesNotThrow(() => validateCodexCommand("C:\\Program Files\\codex\\codex.exe"));
});

test("validateModel: null/undefined ok; token válido ok; inválido rejeitado", () => {
  assert.equal(validateModel(null), null);
  assert.equal(validateModel(undefined), null);
  assert.equal(validateModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.throws(() => validateModel("tem espaço"));
  assert.throws(() => validateModel(123));
});

test("validatePromptText: vazio, só espaço, só CRLF são rejeitados (system e user)", () => {
  for (const label of ["system", "user"]) {
    assert.throws(() => validatePromptText("", label));
    assert.throws(() => validatePromptText("   ", label));
    assert.throws(() => validatePromptText("\r\n", label));
    assert.throws(() => validatePromptText("\t \n", label));
  }
});

test("validatePromptText: NUL é rejeitado; texto válido com espaço nas bordas passa", () => {
  assert.throws(() => validatePromptText("ok\x00ok", "system"));
  assert.doesNotThrow(() => validatePromptText("  texto válido  ", "system"));
});

test("validatePositiveInteger: rejeita não-inteiro, negativo, fora de faixa; aceita limites exatos", () => {
  assert.throws(() => validatePositiveInteger(1.5, { min: 1, max: 10 }, "x"));
  assert.throws(() => validatePositiveInteger(-1, { min: 1, max: 10 }, "x"));
  assert.throws(() => validatePositiveInteger(11, { min: 1, max: 10 }, "x"));
  assert.throws(() => validatePositiveInteger(NaN, { min: 1, max: 10 }, "x"));
  assert.equal(validatePositiveInteger(1, { min: 1, max: 10 }, "x"), 1);
  assert.equal(validatePositiveInteger(10, { min: 1, max: 10 }, "x"), 10);
});

test("buildFullPrompt: fronteiras exatas, espaços preservados byte a byte", () => {
  const result = buildFullPrompt("  SYS  ", "  USR  ");
  assert.equal(result, "[SYSTEM INSTRUCTIONS]\n  SYS  \n\n[UNTRUSTED MARKET CONTEXT]\n  USR  ");
});

test("buildCodexArgs: estrutura exata com model", () => {
  const args = buildCodexArgs({ workDir: "/tmp/x", schemaPath: "/tmp/x/schema.json", model: "gpt-5.6-sol" });
  assert.deepEqual(args, [
    "exec",
    "-C", "/tmp/x",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--json",
    "--output-schema", "/tmp/x/schema.json",
    "--disable", "standalone_web_search",
    "-c", "request_max_retries=0",
    "-c", "stream_max_retries=0",
    "--model", "gpt-5.6-sol",
    "-",
  ]);
});

test("buildCodexArgs: sem model, omite --model", () => {
  const args = buildCodexArgs({ workDir: "/tmp/x", schemaPath: "/tmp/x/schema.json", model: null });
  assert.ok(!args.includes("--model"));
  assert.equal(args[args.length - 1], "-");
});

test("buildCodexArgs: NUNCA inclui --ask-for-approval (incompatível com `codex exec`, comprovado via codex exec --help)", () => {
  const withModel = buildCodexArgs({ workDir: "/tmp/x", schemaPath: "/tmp/x/schema.json", model: "gpt-5.6-sol" });
  const withoutModel = buildCodexArgs({ workDir: "/tmp/x", schemaPath: "/tmp/x/schema.json", model: null });
  assert.ok(!withModel.includes("--ask-for-approval"));
  assert.ok(!withoutModel.includes("--ask-for-approval"));
});

test("buildCodexArgs: preserva as demais proteções -- ephemeral, sandbox read-only, web search desabilitado, zero retry, output-schema, stdin", () => {
  const args = buildCodexArgs({ workDir: "/tmp/x", schemaPath: "/tmp/x/schema.json", model: null });
  assert.ok(args.includes("--ephemeral"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--disable") + 1], "standalone_web_search");
  assert.ok(args.includes("request_max_retries=0"));
  assert.ok(args.includes("stream_max_retries=0"));
  assert.equal(args[args.indexOf("--output-schema") + 1], "/tmp/x/schema.json");
  assert.equal(args[args.length - 1], "-"); // prompt via stdin
});

test("buildMinimalEnv: só allowlist, chaves sensíveis nunca copiadas", () => {
  const env = buildMinimalEnv({
    PATH: "C:\\a",
    OPENAI_API_KEY: "sk-should-not-appear",
    ANTHROPIC_API_KEY: "sk-ant-should-not-appear",
    BYBIT_API_KEY: "should-not-appear",
    TELEGRAM_ALERT_BOT_TOKEN: "should-not-appear",
    AGENTROUTER_API_KEY: "should-not-appear",
    RANDOM_VAR: "should-not-appear",
  });
  assert.deepEqual(env, { PATH: "C:\\a" });
});

test("buildMinimalEnv: case-insensitive (casing real do Windows) escreve nome canônico", () => {
  const env = buildMinimalEnv({ Path: "C:\\a", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe" });
  assert.deepEqual(env, { PATH: "C:\\a", SYSTEMROOT: "C:\\Windows", COMSPEC: "C:\\Windows\\cmd.exe" });
});

test("buildMinimalEnv: valor não-string é ignorado", () => {
  const env = buildMinimalEnv({ PATH: 123, TEMP: "/tmp" });
  assert.deepEqual(env, { TEMP: "/tmp" });
});

test("buildMinimalEnv: CODEX_HOME só entra se presente na origem", () => {
  assert.deepEqual(buildMinimalEnv({ PATH: "x" }), { PATH: "x" });
  assert.deepEqual(buildMinimalEnv({ PATH: "x", CODEX_HOME: "/custom" }), { PATH: "x", CODEX_HOME: "/custom" });
});

test("isSafeWorkDir: exige pai exato + prefixo; rejeita pai errado e basename sem sufixo", () => {
  const tmpdirFn = () => "/fake/tmp";
  assert.equal(isSafeWorkDir("/fake/tmp/" + WORKDIR_PREFIX + "abc", tmpdirFn), true);
  assert.equal(isSafeWorkDir("/outro/lugar/" + WORKDIR_PREFIX + "abc", tmpdirFn), false);
  assert.equal(isSafeWorkDir("/fake/tmp/outro-prefixo-abc", tmpdirFn), false);
  assert.equal(isSafeWorkDir("/fake/tmp/" + WORKDIR_PREFIX, tmpdirFn), false); // sem sufixo nenhum
  assert.equal(isSafeWorkDir("/fake/tmp/sub/" + WORKDIR_PREFIX + "abc", tmpdirFn), false); // subdiretório, pai errado
});

test("cleanupWorkDir: caminho seguro chama rmFn; caminho inseguro só avisa, nunca chama rmFn", async () => {
  const tmpdirFn = () => "/fake/tmp";
  let rmCalled = false;
  const safeErrors = [];
  await cleanupWorkDir({
    workDir: "/fake/tmp/" + WORKDIR_PREFIX + "abc",
    rmFn: async () => { rmCalled = true; },
    onCleanupError: (p) => safeErrors.push(p),
    tmpdirFn,
  });
  assert.equal(rmCalled, true);
  assert.deepEqual(safeErrors, []);

  rmCalled = false;
  const unsafeErrors = [];
  await cleanupWorkDir({
    workDir: "/outro/lugar/malicious",
    rmFn: async () => { rmCalled = true; },
    onCleanupError: (p) => unsafeErrors.push(p),
    tmpdirFn,
  });
  assert.equal(rmCalled, false);
  assert.deepEqual(unsafeErrors, [{ code: "AGENTROUTER_CLEANUP_SKIPPED_UNSAFE_PATH" }]);
});

test("cleanupWorkDir: rmFn rejeitando nunca propaga, só chama onCleanupError", async () => {
  const tmpdirFn = () => "/fake/tmp";
  const errors = [];
  await assert.doesNotReject(
    cleanupWorkDir({
      workDir: "/fake/tmp/" + WORKDIR_PREFIX + "abc",
      rmFn: async () => { throw new Error("disco cheio"); },
      onCleanupError: (p) => errors.push(p),
      tmpdirFn,
    })
  );
  assert.deepEqual(errors, [{ code: "AGENTROUTER_CLEANUP_FAILED" }]);
});

test("cleanupWorkDir: tmpdirFn quebrado (lança) nunca propaga", async () => {
  const errors = [];
  await assert.doesNotReject(
    cleanupWorkDir({
      workDir: "/fake/tmp/" + WORKDIR_PREFIX + "abc",
      rmFn: async () => {},
      onCleanupError: (p) => errors.push(p),
      tmpdirFn: () => { throw new Error("tmpdirFn quebrado"); },
    })
  );
  assert.deepEqual(errors, [{ code: "AGENTROUTER_CLEANUP_FAILED" }]);
});

// ============================================================
// runAgentRouterPrompt -- fluxo completo
// ============================================================

test("validação de entrada rejeita ANTES de chamar spawn (timeoutMs/maxPromptBytes/codexCommand inválidos)", async () => {
  let spawnCalls = 0;
  const spawn = () => {
    spawnCalls++;
    return createFakeChild();
  };
  await assert.rejects(runAgentRouterPrompt(baseOptions({ spawn, timeoutMs: -1 })), (e) => e.code === "AGENTROUTER_SPAWN_ERROR");
  await assert.rejects(runAgentRouterPrompt(baseOptions({ spawn, maxPromptBytes: 5 })), (e) => e.code === "AGENTROUTER_SPAWN_ERROR");
  await assert.rejects(runAgentRouterPrompt(baseOptions({ spawn, codexCommand: "codex.cmd" })), (e) => e.code === "AGENTROUTER_SPAWN_ERROR");
  assert.equal(spawnCalls, 0);
});

test("sucesso: resolve com text/usage/threadId/meta corretos; workDir limpo; lock liberado", async () => {
  const child = createFakeChild();
  const fs = fakeFs();
  const promise = runAgentRouterPrompt(baseOptions({ ...fs, model: "gpt-5.6-sol", spawn: () => child }));
  emitSuccessAndClose(child);
  const result = await promise;

  assert.equal(result.text, '{"bias":"neutral"}');
  assert.deepEqual(result.usage, { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 });
  assert.equal(result.threadId, "thread-abc");
  assert.equal(result.meta.transport, "codex_cli");
  assert.equal(result.meta.invocationNote, "one Codex invocation per assessment, zero transport retries");
  assert.equal(result.meta.modelRequested, "gpt-5.6-sol");
  assert.equal(result.meta.modelEffective, null);
  assert.equal(result.meta.exitCode, 0);
  assert.equal(result.meta.closeConfirmed, true);

  await flushMicrotasks();
  assert.equal(fs.rmCalls.length, 1);

  // lock liberado -- uma chamada seguinte não é BUSY
  const child2 = createFakeChild();
  const promise2 = runAgentRouterPrompt(baseOptions({ spawn: () => child2 }));
  emitSuccessAndClose(child2);
  await assert.doesNotReject(promise2);
});

test("args passados ao spawn nunca contêm o texto do prompt; stdin recebe o prompt completo", async () => {
  const child = createFakeChild();
  let capturedArgs = null;
  const spawn = (cmd, args) => {
    capturedArgs = args;
    return child;
  };
  const promise = runAgentRouterPrompt(baseOptions({ system: "SEGREDO_DE_SYSTEM", user: "SEGREDO_DE_USER", spawn }));
  emitSuccessAndClose(child);
  await promise;

  for (const arg of capturedArgs) {
    assert.ok(!String(arg).includes("SEGREDO_DE_SYSTEM"));
    assert.ok(!String(arg).includes("SEGREDO_DE_USER"));
  }
  assert.equal(capturedArgs[capturedArgs.length - 1], "-");
  assert.equal(child.stdin.writes[0], buildFullPrompt("SEGREDO_DE_SYSTEM", "SEGREDO_DE_USER"));
});

test("env passado ao spawn é o minimal env (allowlist só)", async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  const spawn = (cmd, args, opts) => {
    capturedEnv = opts.env;
    return child;
  };
  const promise = runAgentRouterPrompt(baseOptions({ spawn, env: { PATH: "x", OPENAI_API_KEY: "sk-nope" } }));
  emitSuccessAndClose(child);
  await promise;
  assert.deepEqual(capturedEnv, { PATH: "x" });
});

test("spawn com shell:false e windowsHide:true, nunca shell:true", async () => {
  const child = createFakeChild();
  let capturedOpts = null;
  const spawn = (cmd, args, opts) => {
    capturedOpts = opts;
    return child;
  };
  const promise = runAgentRouterPrompt(baseOptions({ spawn }));
  emitSuccessAndClose(child);
  await promise;
  assert.equal(capturedOpts.shell, false);
  assert.equal(capturedOpts.windowsHide, true);
});

test("exit code != 0 -> AGENTROUTER_EXIT_NONZERO", async () => {
  const child = createFakeChild();
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  child.stdout.emit("data", Buffer.from(SUCCESS_JSONL, "utf8"));
  child.emit("close", 1, null);
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_EXIT_NONZERO");
});

test("JSONL inválido (stream corrompido) -> AGENTROUTER_STREAM_INVALID", async () => {
  const child = createFakeChild();
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  child.stdout.emit("data", Buffer.from("isto não é json\nnem isto\n", "utf8"));
  child.emit("close", 0, null);
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_STREAM_INVALID");
});

test("resposta incompleta (sem turn.completed) -> AGENTROUTER_RESPONSE_INCOMPLETE", async () => {
  const child = createFakeChild();
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  child.stdout.emit("data", Buffer.from(JSON.stringify(SUCCESS_EVENTS[2]) + "\n", "utf8"));
  child.emit("close", 0, null);
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_RESPONSE_INCOMPLETE");
});

test("erro no parser (chunk inválido no stdout) -> AGENTROUTER_STREAM_INVALID mesmo com exit 0", async () => {
  const child = createFakeChild();
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  // stdout emitindo algo que não é string nem Buffer -- jsonlParser.push() lança TypeError
  child.stdout.emit("data", 12345);
  child.emit("close", 0, null);
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_STREAM_INVALID");
});

test("erro de escrita em stdin -> AGENTROUTER_STDIN_ERROR mesmo com stream aparentemente completo", async () => {
  const child = createFakeChild();
  child.stdin.endError = new Error("EPIPE");
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  emitSuccessAndClose(child); // stream "parece" completo
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_STDIN_ERROR");
});

test("spawn lança síncrono -> AGENTROUTER_SPAWN_ERROR, lock liberado", async () => {
  const spawn = () => {
    throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
  };
  await assert.rejects(runAgentRouterPrompt(baseOptions({ spawn })), (e) => e.code === "AGENTROUTER_SPAWN_ERROR");

  const child2 = createFakeChild();
  const promise2 = runAgentRouterPrompt(baseOptions({ spawn: () => child2 }));
  emitSuccessAndClose(child2);
  await assert.doesNotReject(promise2);
});

test("evento 'error' SEM pid -> AGENTROUTER_SPAWN_ERROR imediato, lock liberado", async () => {
  const child = createFakeChild({ pid: null }); // null (não undefined -- default de desestruturação substituiria undefined)
  const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child }));
  child.emit("error", new Error("ENOENT"));
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_SPAWN_ERROR");

  const child2 = createFakeChild();
  const promise2 = runAgentRouterPrompt(baseOptions({ spawn: () => child2 }));
  emitSuccessAndClose(child2);
  await assert.doesNotReject(promise2);
});

test("evento 'error' COM pid vivo -> não libera na hora; killProcessTree chamado; libera só após 'close'", async () => {
  const child = createFakeChild({ pid: 999 });
  const clock = createManualClock();
  let killCalls = 0;
  const killProcessTree = async () => { killCalls++; };

  const promise = runAgentRouterPrompt(
    baseOptions({ spawn: () => child, killProcessTree, setTimeoutFn: clock.fakeSetTimeout, clearTimeoutFn: clock.fakeClearTimeout })
  );
  child.emit("error", new Error("EPIPE pós-start"));
  await flushMicrotasks();
  assert.equal(killCalls, 1);

  // ainda não resolveu -- close chega dentro da graça
  child.emit("close", null, "SIGKILL");
  await assert.rejects(promise, (e) => e.code === "AGENTROUTER_SPAWN_ERROR");
});

test("timeout: close chega dentro da graça -> AGENTROUTER_TIMEOUT, lock liberado, closeConfirmed true", async () => {
  const child = createFakeChild();
  const clock = createManualClock();
  const fs = fakeFs();
  let killCalls = 0;
  const killProcessTree = async () => { killCalls++; };

  const promise = runAgentRouterPrompt(
    baseOptions({ ...fs, spawn: () => child, killProcessTree, setTimeoutFn: clock.fakeSetTimeout, clearTimeoutFn: clock.fakeClearTimeout })
  );
  clock.fireOldest(); // dispara o timeoutTimer principal
  await flushMicrotasks();
  assert.equal(killCalls, 1);

  child.emit("close", null, "SIGKILL"); // close chega ANTES do grace timer disparar
  const err = await promise.catch((e) => e);
  assert.equal(err.code, "AGENTROUTER_TIMEOUT");
  assert.equal(err.meta.closeConfirmed, true);

  await flushMicrotasks();
  assert.equal(fs.rmCalls.length, 1);

  const child2 = createFakeChild();
  const promise2 = runAgentRouterPrompt(baseOptions({ spawn: () => child2 }));
  emitSuccessAndClose(child2);
  await assert.doesNotReject(promise2);
});

test("timeout: grace esgota SEM close -> lock fica preso (BUSY na próxima); close tardio libera depois", async () => {
  const child = createFakeChild();
  const clock = createManualClock();
  const fs = fakeFs();
  const killProcessTree = async () => {};

  const promise = runAgentRouterPrompt(
    baseOptions({ ...fs, spawn: () => child, killProcessTree, setTimeoutFn: clock.fakeSetTimeout, clearTimeoutFn: clock.fakeClearTimeout })
  );
  clock.fireOldest(); // timeoutTimer principal
  await flushMicrotasks();
  clock.fireOldest(); // graceTimer -- ninguém emitiu 'close'

  const err = await promise.catch((e) => e);
  assert.equal(err.code, "AGENTROUTER_TIMEOUT");
  assert.equal(err.meta.closeConfirmed, false);

  // lock continua preso -- próxima chamada é BUSY, spawn nem é chamado
  let spawnCalls = 0;
  await assert.rejects(
    runAgentRouterPrompt(baseOptions({ spawn: () => { spawnCalls++; return createFakeChild(); } })),
    (e) => e.code === "AGENTROUTER_BUSY"
  );
  assert.equal(spawnCalls, 0);
  assert.equal(fs.rmCalls.length, 0); // ainda não limpou

  // 'close' tardio finalmente chega no processo original
  child.emit("close", null, "SIGKILL");
  await flushMicrotasks();
  assert.equal(fs.rmCalls.length, 1); // agora sim limpou

  // lock finalmente liberado
  const child2 = createFakeChild();
  const promise2 = runAgentRouterPrompt(baseOptions({ spawn: () => child2 }));
  emitSuccessAndClose(child2);
  await assert.doesNotReject(promise2);
});

test("BUSY: segunda chamada concorrente rejeita sem nunca chamar spawn", async () => {
  const child1 = createFakeChild();
  const promise1 = runAgentRouterPrompt(baseOptions({ spawn: () => child1 }));

  let spawn2Calls = 0;
  await assert.rejects(
    runAgentRouterPrompt(baseOptions({ spawn: () => { spawn2Calls++; return createFakeChild(); } })),
    (e) => e.code === "AGENTROUTER_BUSY"
  );
  assert.equal(spawn2Calls, 0);

  emitSuccessAndClose(child1);
  await promise1;
});

test("killProcessTree injetado lançando síncrono OU devolvendo Promise rejeitada nunca vira unhandled rejection", async () => {
  const throwingKill = () => {
    throw new Error("kill síncrono quebrado");
  };
  const rejectingKill = () => Promise.reject(new Error("kill assíncrono quebrado"));

  for (const killProcessTree of [throwingKill, rejectingKill]) {
    const child = createFakeChild();
    const clock = createManualClock();
    const promise = runAgentRouterPrompt(
      baseOptions({ spawn: () => child, killProcessTree, setTimeoutFn: clock.fakeSetTimeout, clearTimeoutFn: clock.fakeClearTimeout })
    );
    clock.fireOldest(); // timeout principal, aciona killProcessTree quebrado
    await flushMicrotasks();
    clock.fireOldest(); // grace, ninguém fechou
    await assert.rejects(promise, (e) => e.code === "AGENTROUTER_TIMEOUT");
    child.emit("close", null, "SIGKILL"); // libera pro próximo teste do loop
    await flushMicrotasks();
  }
});

test("onCleanupError injetado lançando OU devolvendo Promise rejeitada nunca vira unhandled rejection", async () => {
  const throwingCb = () => {
    throw new Error("callback quebrado");
  };
  const rejectingCb = () => Promise.reject(new Error("callback assíncrono quebrado"));

  for (const onCleanupError of [throwingCb, rejectingCb]) {
    const child = createFakeChild();
    const promise = runAgentRouterPrompt(baseOptions({ spawn: () => child, onCleanupError, tmpdirFn: () => "/outro" })); // workDir fake não bate no tmpdir -> cleanup "unsafe" dispara onCleanupError
    emitSuccessAndClose(child);
    await assert.doesNotReject(promise);
    await flushMicrotasks();
  }
});

// ============================================================
// Checagem final: nenhuma unhandled rejection em toda a suíte
// ============================================================

test("nenhuma unhandled rejection ocorreu durante toda a suíte", async () => {
  await flushMicrotasks();
  assert.deepEqual(unhandledRejections, []);
});

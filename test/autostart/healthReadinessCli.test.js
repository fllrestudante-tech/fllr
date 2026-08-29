const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const CLI_PATH = path.join(__dirname, "..", "..", "lib", "autostart", "healthReadinessCli.js");

function runCli(stdinText) {
  return spawnSync(process.execPath, [CLI_PATH], { input: stdinText, encoding: "utf8", timeout: 10_000 });
}

const READY_BODY = { status: "ok", mode: "safe", tradingExecutionEnabled: false, database: "ok" };

test("healthReadinessCli: corpo pronto via stdin -> stdout 'true', exit 0", () => {
  const result = runCli(JSON.stringify({ statusCode: 200, body: READY_BODY }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "true");
});

test("healthReadinessCli: 503 via stdin -> stdout 'false', exit 0 (decisão no texto, não no exit code)", () => {
  const result = runCli(JSON.stringify({ statusCode: 503, body: { ...READY_BODY, status: "degraded" } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false");
});

test("healthReadinessCli: JSON inválido no stdin -> 'false', nunca lança, nunca derruba o processo", () => {
  const result = runCli("isto nao e json valido {{{");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false");
  assert.equal(result.stderr, "");
});

test("healthReadinessCli: stdin vazio -> 'false'", () => {
  const result = runCli("");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false");
});

test("healthReadinessCli: BOM (U+FEFF) no início do stdin é descartado -- reproduz o que o Windows PowerShell 5.1 realmente envia (Process.StandardInput injeta BOM automaticamente, confirmado testando o fluxo real de scripts/autostart/*.ps1)", () => {
  const result = runCli("﻿" + JSON.stringify({ statusCode: 200, body: READY_BODY }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "true");
});

test("healthReadinessCli: nunca imprime nada além de 'true'/'false' -- sem eco de segredo/entrada", () => {
  const result = runCli(JSON.stringify({ statusCode: 200, body: { ...READY_BODY, extra: "segredo-fake-nao-deve-aparecer" } }));
  assert.equal(result.stdout, "true"); // campo extra não derruba, mas também não é ecoado
  assert.ok(!result.stdout.includes("segredo-fake-nao-deve-aparecer"));
});

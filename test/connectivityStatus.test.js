const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readStatus, isOnline, isProviderHealthy, getStatus } = require("../lib/connectivityStatus");

function tmpFile(name) {
  return path.join(os.tmpdir(), `bot-cripto10-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test("isOnline: true quando o snapshot não existe ainda (falha aberto, não bloqueia no boot)", () => {
  const file = tmpFile("missing.json");
  assert.equal(isOnline(file), true);
  assert.equal(readStatus(file), null);
});

test("isOnline: reflete online:false do snapshot real", () => {
  const file = tmpFile("offline.json");
  fs.writeFileSync(file, JSON.stringify({ online: false, providers: { bybit: false } }));
  assert.equal(isOnline(file), false);
  fs.unlinkSync(file);
});

test("isOnline: true quando online:true no snapshot", () => {
  const file = tmpFile("online.json");
  fs.writeFileSync(file, JSON.stringify({ online: true, providers: { bybit: true } }));
  assert.equal(isOnline(file), true);
  fs.unlinkSync(file);
});

test("isProviderHealthy: reflete o provider específico, não o online geral", () => {
  const file = tmpFile("provider.json");
  fs.writeFileSync(file, JSON.stringify({ online: true, providers: { bybit: false, coingecko: true, telegram: true } }));
  assert.equal(isProviderHealthy("bybit", file), false);
  assert.equal(isProviderHealthy("coingecko", file), true);
  fs.unlinkSync(file);
});

test("isProviderHealthy: true por padrão se o provider não estiver no snapshot (fonte não coberta ainda)", () => {
  const file = tmpFile("partial.json");
  fs.writeFileSync(file, JSON.stringify({ online: true, providers: { bybit: true } }));
  assert.equal(isProviderHealthy("coingecko", file), true);
  fs.unlinkSync(file);
});

test("readStatus: retorna null (não lança) se o arquivo tiver JSON inválido (leitura no meio de uma escrita)", () => {
  const file = tmpFile("corrupt.json");
  fs.writeFileSync(file, "{ isso nao e json valido");
  assert.equal(readStatus(file), null);
  fs.unlinkSync(file);
});

test("getStatus: devolve o snapshot completo", () => {
  const file = tmpFile("full.json");
  const payload = { online: false, reason: "bybit_down", since: 123, providers: { bybit: false, coingecko: true, telegram: true, database: true } };
  fs.writeFileSync(file, JSON.stringify(payload));
  assert.deepEqual(getStatus(file), payload);
  fs.unlinkSync(file);
});

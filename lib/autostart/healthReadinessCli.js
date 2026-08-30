#!/usr/bin/env node
// CLI mínimo pra scripts/autostart/*.ps1 reaproveitarem a MESMA decisão
// testada de lib/autostart/healthReadiness.js, em vez de reimplementar a
// checagem em PowerShell (evita duas versões divergindo com o tempo).
// Lê UM objeto JSON de stdin: {"statusCode": 200, "body": {...},
// "expectedMode": "safe"|"demo_observe"}. `expectedMode` é opcional --
// ausente equivale a "safe" (retrocompatível, mesmo comportamento de
// sempre). Nunca lança pra entrada malformada -- JSON inválido ou campos
// ausentes só reprovam (imprime "false"). Imprime exatamente "true" ou
// "false" (sem mais nada) em stdout e sempre sai com código 0 -- a
// decisão vai no texto, não no exit code, pra ficar simples de capturar
// em uma linha do PowerShell.
const { isHealthResponseReady } = require("./healthReadiness");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // Descarta um BOM (U+FEFF) inicial se presente -- o .NET Framework por
  // trás do Windows PowerShell 5.1 injeta um BOM automaticamente ao
  // escrever em Process.StandardInput (confirmado testando o fluxo real
  // de scripts/autostart/*.ps1 nesta rodada; StandardInputEncoding nem
  // existe nessa versão pra configurar isso na origem). JSON não aceita
  // BOM -- sem este strip, todo payload vindo do PowerShell reprovaria
  // aqui por engano.
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let parsed;
  try {
    parsed = JSON.parse(withoutBom);
  } catch {
    process.stdout.write("false");
    return;
  }
  const expectedMode = parsed && typeof parsed.expectedMode === "string" ? parsed.expectedMode : undefined;
  process.stdout.write(isHealthResponseReady(parsed, expectedMode !== undefined ? { expectedMode } : undefined) ? "true" : "false");
});

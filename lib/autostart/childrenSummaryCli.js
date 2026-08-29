#!/usr/bin/env node
// CLI mínimo pra scripts/autostart/*.ps1 lerem a lista canônica de
// processos (lib/supervisorProfile.js) sem reimplementá-la em PowerShell.
// Imprime UM objeto JSON em stdout: { safe: {children, skipped}, all: [...] }.
// Nunca lê/imprime nenhum valor de credencial -- só nomes/caminhos de
// script/categoria, os mesmos já usados por scripts/supervisor.js.
const { getAllChildrenSummary, getSafeChildrenSummary } = require("./childrenSummary");

process.stdout.write(
  JSON.stringify({
    safe: getSafeChildrenSummary(),
    all: getAllChildrenSummary(),
  })
);

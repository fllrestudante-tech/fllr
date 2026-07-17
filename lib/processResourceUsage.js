// Amostra CPU%/RAM de um conjunto de PIDs via wmic (Windows -- mesma
// plataforma já assumida em scripts/supervisor.js pros comentários sobre
// sinais). `parseWmicCsv` é pura/testável sem chamar wmic de verdade;
// `sampleProcessResources` é a casca fina que chama o processo real e nunca
// derruba o sampler se wmic falhar/não existir (resource usage é
// enriquecimento do dashboard, não um dado crítico).
const { execFileSync } = require("child_process");

function parseWmicCsv(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const result = {};
  if (lines.length < 2) return result;

  const header = lines[0].split(",");
  const idIdx = header.indexOf("IDProcess");
  const cpuIdx = header.indexOf("PercentProcessorTime");
  const ramIdx = header.indexOf("WorkingSetPrivate");
  if (idIdx === -1) return result;

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const pid = Number(cols[idIdx]);
    if (!pid) continue;
    result[pid] = {
      cpuPercent: cpuIdx !== -1 ? Number(cols[cpuIdx]) : null,
      ramBytes: ramIdx !== -1 ? Number(cols[ramIdx]) : null,
    };
  }
  return result;
}

function sampleProcessResources(pids, { exec = execFileSync } = {}) {
  const validPids = pids.filter((p) => typeof p === "number" && p > 0);
  if (validPids.length === 0) return {};

  const filter = validPids.map((pid) => `IDProcess=${pid}`).join(" or ");
  let raw;
  try {
    raw = exec(
      "wmic",
      ["path", "Win32_PerfFormattedData_PerfProc_Process", "where", filter, "get", "IDProcess,PercentProcessorTime,WorkingSetPrivate", "/format:csv"],
      { timeout: 5000 }
    ).toString("utf8");
  } catch {
    return {};
  }

  return parseWmicCsv(raw);
}

module.exports = { sampleProcessResources, parseWmicCsv };

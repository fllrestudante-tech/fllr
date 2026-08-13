// Checkpoint único de 24h do AI Gateway (bot-cripto10). Roda UMA vez,
// agendado pra disparar exatamente 24h depois do restart controlado do
// metrics_sampler (2026-08-11T23:33:39.374Z UTC -- ver
// runtime/processes/state.json::metrics_sampler.startedAt no momento do
// restart), não "24h a partir de quando isso for agendado".
//
// Somente observabilidade -- nunca reinicia/mata/altera nenhum processo,
// nunca toca em config.js/preço/modelo/prompt/policy/Risk/Execution, nunca
// conecta a scripts/health.js nem index.js. A ÚNICA escrita em disco feita
// por este script é o próprio arquivo de relatório
// (runtime/ai-cost-checkpoint-24h-*.txt) -- não é "só leitura" no sentido
// literal (essa escrita existe e é intencional), mas não tem nenhum efeito
// sobre processo/config/trading. Fica fora de scripts/supervisor.js de
// propósito: não é um processo de longa duração, dispara e termina sozinho
// (o Agendador de Tarefas do Windows é quem controla a hora, não este
// arquivo -- ver instruções de registro no chat que acompanhou este script).
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { computeAiCostMetrics } = require("../lib/aiGateway/costMetrics");
const dashboard = require("../lib/dashboard");

const ROOT = path.join(__dirname, "..");

// Baseline capturado no exato momento do restart controlado (não
// recalculado a cada execução -- é literalmente "o que era verdade antes de
// começar a contar as 24h"). metricsSamplerPid/TotalRestarts e
// botPid/TotalRestarts vêm de runtime/processes/state.json logo depois do
// `taskkill /F /PID 1184` que derrubou o metrics_sampler antigo.
const BASELINE = {
  restartedAt: "2026-08-11T23:33:39.374Z",
  metricsSamplerPid: 52888,
  metricsSamplerTotalRestarts: 1,
  botPid: 54988,
  botTotalRestarts: 2,
};

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function tailLines(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-maxLines);
}

/**
 * Balloon tip nativo do .NET (System.Windows.Forms), sem dependência nova
 * nenhuma -- já vem com qualquer Windows que tenha PowerShell. Falha
 * silenciosamente (ex: tarefa agendada rodando sem sessão de desktop
 * interativa) -- notificação é extra, nunca deveria derrubar o relatório
 * em si, que já foi salvo em arquivo antes desta chamada.
 */
function showWindowsNotification(title, message) {
  const escape = (s) => s.replace(/"/g, '\\"').replace(/`/g, "``");
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$notify = New-Object System.Windows.Forms.NotifyIcon",
    "$notify.Icon = [System.Drawing.SystemIcons]::Information",
    "$notify.Visible = $true",
    `$notify.ShowBalloonTip(15000, "${escape(title)}", "${escape(message)}", [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Seconds 16",
    "$notify.Dispose()",
  ].join("; ");
  try {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psScript], { windowsHide: true }, () => {});
  } catch {
    // notificação é best-effort -- relatório em arquivo já é a fonte de verdade
  }
}

function main() {
  const now = new Date();
  const restartedAt = new Date(BASELINE.restartedAt);
  const elapsedMs = now - restartedAt;
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  const completed24h = elapsedHours >= 24;

  const lines = [];
  lines.push(`Checkpoint de 24h -- AI Gateway (bot-cripto10)`);
  lines.push(`Gerado em: ${now.toISOString()}`);
  lines.push("=".repeat(70));
  lines.push(`Restart do metrics_sampler (baseline): ${BASELINE.restartedAt}`);
  lines.push(`Tempo decorrido desde o baseline: ${elapsedHours.toFixed(2)}h`);
  lines.push(`24h completadas? ${completed24h ? "SIM" : "⚠️  NÃO -- este relatório rodou antes da hora prevista"}`);
  lines.push("");

  // --- Integridade de processo: algo mudou desde o baseline do restart? ---
  lines.push("Integridade de processo (comparado ao baseline do restart):");
  const procState = readJsonSafe(path.join(ROOT, "runtime", "processes", "state.json"));
  if (procState) {
    const sampler = procState.metrics_sampler;
    const bot = procState.bot;

    const samplerPidChanged = sampler && sampler.pid !== BASELINE.metricsSamplerPid;
    const samplerRestartsChanged = sampler && sampler.totalRestarts !== BASELINE.metricsSamplerTotalRestarts;
    const botPidChanged = bot && bot.pid !== BASELINE.botPid;
    const botRestartsChanged = bot && bot.totalRestarts !== BASELINE.botTotalRestarts;

    lines.push(
      `  metrics_sampler: pid=${sampler?.pid ?? "?"} (baseline ${BASELINE.metricsSamplerPid}) ${samplerPidChanged ? "-- MUDOU (houve novo restart do sampler durante a janela)" : "-- igual ao baseline"}`
    );
    lines.push(
      `  metrics_sampler: totalRestarts=${sampler?.totalRestarts ?? "?"} (baseline ${BASELINE.metricsSamplerTotalRestarts}) ${samplerRestartsChanged ? "-- MUDOU" : "-- igual"}`
    );
    lines.push(
      `  bot: pid=${bot?.pid ?? "?"} (baseline ${BASELINE.botPid}) ${botPidChanged ? "-- ⚠️  MUDOU (bot foi reiniciado -- não deveria ter sido tocado nesta janela)" : "-- igual, não tocado"}`
    );
    lines.push(
      `  bot: totalRestarts=${bot?.totalRestarts ?? "?"} (baseline ${BASELINE.botTotalRestarts}) ${botRestartsChanged ? "-- ⚠️  MUDOU" : "-- igual"}`
    );
  } else {
    lines.push("  ⚠️  runtime/processes/state.json não encontrado -- supervisor pode não estar rodando");
  }
  lines.push("");

  // --- Métricas de custo reais (mesmo cálculo de lib/aiGateway/costMetrics.js) ---
  const metrics = computeAiCostMetrics();
  lines.push("Métricas de custo (janela de 24h real, calculada agora a partir de data/ai-assessments.jsonl):");
  lines.push(...dashboard.formatAiCostSection(metrics));
  lines.push("");
  lines.push(`Janela cobre 24h reais de log (não só desde o restart)? ${metrics.isFullWindow ? "SIM" : "NÃO"} (${metrics.sampleWindowHours}h de ${metrics.windowHours}h)`);
  lines.push("");

  // --- Snapshot já persistido pelo metrics_sampler (tier lento) ---
  const snapshotFile = path.join(ROOT, "runtime", "metrics", "ai-cost.json");
  const snapshot = readJsonSafe(snapshotFile);
  lines.push(`Último snapshot gravado pelo metrics_sampler: ${snapshot ? snapshot.sampledAt : "não encontrado"} (${snapshotFile})`);
  lines.push("");

  // --- Erros do sampler no log de hoje e de ontem (cobre a virada de dia) ---
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const errorLines = [];
  for (const day of [yesterdayStr, todayStr]) {
    const logPath = path.join(ROOT, "logs", day, "metrics_sampler.log");
    const dayLines = tailLines(logPath, 500).filter((l) => l.includes("⚠️") || /erro|error/i.test(l));
    for (const l of dayLines) errorLines.push(`[${day}] ${l}`);
  }
  lines.push(`Erros do metrics_sampler nos logs de ${yesterdayStr}/${todayStr}: ${errorLines.length}`);
  if (errorLines.length) errorLines.slice(-15).forEach((l) => lines.push(`  ${l}`));
  lines.push("");

  const report = lines.join("\n");
  console.log(report);

  const outDir = path.join(ROOT, "runtime");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `ai-cost-checkpoint-24h-${now.toISOString().replace(/[:.]/g, "-")}.txt`);
  fs.writeFileSync(outFile, report + "\n");
  console.log(`\n(relatório salvo em ${outFile})`);

  const costLabel = metrics.AI_COST_ESTIMATE_INCOMPLETE ? `$${metrics.AI_COST_ESTIMATE_24H}+ (parcial)` : `$${metrics.AI_COST_ESTIMATE_24H}`;
  showWindowsNotification(
    "Cripto10 -- Checkpoint 24h AI Gateway concluído",
    `${metrics.AI_ASSESSMENTS_24H} assessments, ${metrics.AI_PROVIDER_ATTEMPTS_24H} tentativas, custo ${costLabel}. Relatório salvo em runtime/.`
  );
}

main();

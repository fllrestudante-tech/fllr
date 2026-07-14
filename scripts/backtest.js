const backtest = require("../lib/backtest");

backtest
  .run()
  .then((output) => {
    console.log(output.lastRun.promoted ? "✅ Candidato promovido a produção:" : "⏸️  Baseline mantido (candidato não passou no gate):");
    console.log(`Motivo: ${output.lastRun.reason}`);
    console.log("Parâmetros em produção:", JSON.stringify(output.current, null, 2));
    console.log("Baseline:", output.lastRun.baseline);
    console.log("Candidato:", output.lastRun.candidate);
  })
  .catch((err) => {
    console.error("❌ Backtest falhou:", err.message);
    process.exit(1);
  });

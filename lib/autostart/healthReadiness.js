// Critério de aceitação do wrapper de autostart -- INDEPENDENTE do que o
// dashboard decide internamente (lib/webDashboard/dashboardHealth.js). O
// wrapper nunca deveria confiar cegamente num único booleano `status`;
// confere cada campo que importa pra decisão "posso abrir o navegador com
// segurança?" explicitamente. Puro, sem I/O -- só compara o objeto já
// parseado (o parsing de JSON/HTTP é responsabilidade de quem chama).
const REQUIRED_SHAPE = {
  status: "ok",
  mode: "safe",
  tradingExecutionEnabled: false,
  database: "ok",
};

// Perfil demo + DEMO_EXECUTION_MODE=observe (fase "observação") -- exige,
// ADEMAIS do REQUIRED_SHAPE base (status/tradingExecutionEnabled/database,
// exceto `mode`, que aqui é "demo" em vez de "safe"), os dois campos
// específicos que só lib/webDashboard/dashboardHealth.js sabe calcular:
// executionMode="observe" e newExposureAllowed=false -- NUNCA suficiente
// só `status==="ok"` pra decidir que é seguro abrir o navegador num
// perfil demo; o wrapper de autostart precisa confirmar explicitamente
// que "saudável" aqui significa "pra observação", nunca "pronto pra
// negociar".
const REQUIRED_SHAPE_DEMO_OBSERVE = {
  status: "ok",
  mode: "demo",
  executionMode: "observe",
  tradingExecutionEnabled: false,
  newExposureAllowed: false,
  database: "ok",
};

const EXPECTED_MODES = Object.freeze({ SAFE: "safe", DEMO_OBSERVE: "demo_observe" });

/**
 * `{ statusCode, body }` -- `body` já deve ser um objeto (JSON já
 * parseado) ou `null`/`undefined` (ex.: JSON inválido -- nunca lança aqui,
 * só reprova). `expectedMode` (default "safe", mesmo comportamento de
 * sempre -- retrocompatível) seleciona QUAL forma exigir: "safe" (4
 * campos do REQUIRED_SHAPE original) ou "demo_observe" (6 campos do
 * REQUIRED_SHAPE_DEMO_OBSERVE). Sucesso exige TODOS os campos da forma
 * selecionada exatamente iguais aos esperados, além de `statusCode ===
 * 200` -- nenhum campo extra ausente silenciosamente aprova, nenhum
 * campo a mais é ignorado sem checagem dos que importam, e nenhum
 * `expectedMode` desconhecido aprova nada (fail-closed).
 */
function isHealthResponseReady({ statusCode, body } = {}, { expectedMode = EXPECTED_MODES.SAFE } = {}) {
  if (statusCode !== 200) return false;
  if (!body || typeof body !== "object") return false;

  if (expectedMode === EXPECTED_MODES.SAFE) {
    return (
      body.status === REQUIRED_SHAPE.status &&
      body.mode === REQUIRED_SHAPE.mode &&
      body.tradingExecutionEnabled === REQUIRED_SHAPE.tradingExecutionEnabled &&
      body.database === REQUIRED_SHAPE.database
    );
  }

  if (expectedMode === EXPECTED_MODES.DEMO_OBSERVE) {
    return (
      body.status === REQUIRED_SHAPE_DEMO_OBSERVE.status &&
      body.mode === REQUIRED_SHAPE_DEMO_OBSERVE.mode &&
      body.executionMode === REQUIRED_SHAPE_DEMO_OBSERVE.executionMode &&
      body.tradingExecutionEnabled === REQUIRED_SHAPE_DEMO_OBSERVE.tradingExecutionEnabled &&
      body.newExposureAllowed === REQUIRED_SHAPE_DEMO_OBSERVE.newExposureAllowed &&
      body.database === REQUIRED_SHAPE_DEMO_OBSERVE.database
    );
  }

  return false; // expectedMode desconhecido -- nunca aprovado por omissão
}

module.exports = { REQUIRED_SHAPE, REQUIRED_SHAPE_DEMO_OBSERVE, EXPECTED_MODES, isHealthResponseReady };

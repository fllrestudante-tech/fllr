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

/**
 * `{ statusCode, body }` -- `body` já deve ser um objeto (JSON já
 * parseado) ou `null`/`undefined` (ex.: JSON inválido -- nunca lança aqui,
 * só reprova). Sucesso exige TODOS os campos exatamente iguais aos
 * esperados, além de `statusCode === 200` -- nenhum campo extra ausente
 * silenciosamente aprova, nenhum campo a mais é ignorado sem checagem dos
 * que importam.
 */
function isHealthResponseReady({ statusCode, body } = {}) {
  if (statusCode !== 200) return false;
  if (!body || typeof body !== "object") return false;
  return (
    body.status === REQUIRED_SHAPE.status &&
    body.mode === REQUIRED_SHAPE.mode &&
    body.tradingExecutionEnabled === REQUIRED_SHAPE.tradingExecutionEnabled &&
    body.database === REQUIRED_SHAPE.database
  );
}

module.exports = { REQUIRED_SHAPE, isHealthResponseReady };

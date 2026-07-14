/**
 * Registro genérico de health checks — não sabe nada sobre Bybit/Telegram/etc,
 * só orquestra funções registradas e detecta transição de status entre uma
 * rodada e a próxima (usado por lib/alerts.js pra não alertar a cada ciclo,
 * só quando o status realmente muda).
 */
function createHealthRegistry() {
  const checks = new Map();
  const lastStatuses = new Map();

  function registerCheck(name, fn) {
    checks.set(name, fn);
  }

  async function runChecks() {
    const results = {};
    for (const [name, fn] of checks) {
      try {
        results[name] = await fn();
      } catch (err) {
        results[name] = { status: "down", details: { error: err.message } };
      }
    }
    return results;
  }

  function detectTransitions(results) {
    const transitions = [];
    for (const [name, result] of Object.entries(results)) {
      const prev = lastStatuses.has(name) ? lastStatuses.get(name) : undefined;
      if (prev !== undefined && prev !== result.status) {
        transitions.push({ name, from: prev, to: result.status });
      }
      lastStatuses.set(name, result.status);
    }
    return transitions;
  }

  return { registerCheck, runChecks, detectTransitions };
}

module.exports = { createHealthRegistry };

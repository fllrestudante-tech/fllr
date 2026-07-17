// Modelo de 7 estados operacionais -- camada NOVA e derivada, não muda o que
// lib/healthChecks.js já retorna hoje (ok/degraded/down/not_implemented/
// disabled/stopped continuam existindo como estão). Combina o status do
// supervisor (runtime/processes/state.json: stopped/running/crashed) com o
// resultado do health check (ok/degraded/down) pra chegar num estado só.
//
// Duas ambiguidades reais, resolvidas assim (documentado no plano da Fase B):
// - running+degraded -> continua RUNNING, com `degraded` virando uma flag de
//   severidade à parte -- não existe um estado DEGRADED próprio nos 7.
// - running+down -> ERROR, e só é seguro porque já se sabe (pelo supervisor)
//   que o processo está vivo; um "down" isolado sem esse contexto não dá pra
//   distinguir ERROR de STOPPED.
const STATES = ["RUNNING", "STOPPED", "DISABLED", "MANUAL", "ERROR", "STARTING", "UNKNOWN"];

// Janela depois do spawn em que a ausência de heartbeat/health ainda é
// esperada (o processo pode estar de pé mas não ter feito a primeira coleta
// ainda) -- mesma ordem de grandeza do tick do supervisor (30s) + heartbeat.
const STARTING_WINDOW_MS = 90000;

function deriveOperationalState({ isSupervised = true, supervisorStatus = null, healthStatus = null, startedAt = null, now = Date.now() } = {}) {
  if (!isSupervised) return { state: "MANUAL", degraded: false };
  if (!supervisorStatus) return { state: "UNKNOWN", degraded: false };
  if (supervisorStatus === "stopped") return { state: "STOPPED", degraded: false };
  if (supervisorStatus === "crashed") return { state: "ERROR", degraded: false };

  if (supervisorStatus === "running") {
    const uptimeMs = startedAt ? now - new Date(startedAt).getTime() : null;
    if (uptimeMs !== null && uptimeMs < STARTING_WINDOW_MS && healthStatus == null) {
      return { state: "STARTING", degraded: false };
    }
    if (healthStatus === "down") return { state: "ERROR", degraded: false };
    if (healthStatus === "degraded") return { state: "RUNNING", degraded: true };
    return { state: "RUNNING", degraded: false };
  }

  return { state: "UNKNOWN", degraded: false };
}

module.exports = { deriveOperationalState, STATES };

// Transforma a janela fechada de lib/collectors/collectorMetrics.js
// (contagens brutas) em taxas por minuto -- separado do collectorMetrics
// pra aquele módulo continuar só "contar coisas", não "interpretar taxas".
function ratePerMinute(count, durationMs) {
  if (!durationMs || durationMs <= 0) return null;
  return (count / durationMs) * 60000;
}

/**
 * `lastWindow` é o `{runs, inserted, errors, closedAt, durationMs}` que
 * collectorMetrics.js fecha sozinho. Sem janela fechada ainda (processo
 * recém-iniciado, menos de `windowMs` decorrido), não dá pra calcular uma
 * taxa de verdade -- retorna tudo null em vez de fingir um número com base
 * numa janela parcial.
 */
function computeThroughput(lastWindow) {
  if (!lastWindow) {
    return { insertedPerMin: null, errorsPerMin: null, runsPerMin: null };
  }
  return {
    insertedPerMin: ratePerMinute(lastWindow.inserted, lastWindow.durationMs),
    errorsPerMin: ratePerMinute(lastWindow.errors, lastWindow.durationMs),
    runsPerMin: ratePerMinute(lastWindow.runs, lastWindow.durationMs),
  };
}

module.exports = { ratePerMinute, computeThroughput };

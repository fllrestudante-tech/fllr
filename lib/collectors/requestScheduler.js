// Espaça um conjunto de tarefas (símbolo × domínio) ao longo de uma janela
// de intervalo, em vez de disparar todas no mesmo tick -- existe só pra
// resolver o problema real da Fase A (expansão multi-asset): não rajar a
// API da Bybit com 30-100 símbolos × 5 endpoints de uma vez só. Sem
// dependência nova, sem fila persistente -- puro agendamento em processo.

/**
 * Distribui `taskCount` tarefas uniformemente dentro de `windowMs`,
 * devolvendo o offset (ms) de cada uma a partir do início da janela.
 * Ex: 4 tarefas numa janela de 1000ms -> [0, 250, 500, 750].
 */
function computeStaggeredOffsets(taskCount, windowMs) {
  if (taskCount <= 0) return [];
  const step = windowMs / taskCount;
  return Array.from({ length: taskCount }, (_, i) => Math.round(i * step));
}

/**
 * Semáforo simples: no máximo `maxConcurrent` chamadas de `run(fn)` em voo
 * ao mesmo tempo -- as excedentes esperam numa fila FIFO até uma vaga abrir.
 * Protege contra o caso de uma chamada demorar mais que o esperado e
 * acumular com as próximas (staggering sozinho não garante isso se a
 * latência variar).
 */
function createConcurrencyLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  function next() {
    if (active >= maxConcurrent || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          active--;
          resolve(value);
          next();
        },
        (err) => {
          active--;
          reject(err);
          next();
        }
      );
  }

  function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  }

  return {
    run,
    get activeCount() {
      return active;
    },
    get queuedCount() {
      return queue.length;
    },
  };
}

/**
 * Agenda `tasks` (array de funções, cada uma síncrona ou async) espaçadas
 * dentro de `windowMs`, repetindo a cada janela -- delay inicial de cada
 * tarefa = seu offset calculado por computeStaggeredOffsets, depois um
 * setInterval de `windowMs` assume a repetição. Toda execução passa pelo
 * limiter de concorrência. Retorna { stop, limiter } -- stop cancela tudo de
 * uma vez (mesmo formato de retorno de runCollector/startHeartbeat já
 * existentes), limiter expõe activeCount/queuedCount pra visibilidade de
 * saturação do scheduler (Fase A -- Universe Health / rollout progressivo).
 */
function scheduleStaggered(tasks, windowMs, { maxConcurrent = 5, setTimeoutFn = setTimeout, setIntervalFn = setInterval, clearTimeoutFn = clearTimeout, clearIntervalFn = clearInterval } = {}) {
  const limiter = createConcurrencyLimiter(maxConcurrent);
  const offsets = computeStaggeredOffsets(tasks.length, windowMs);
  const cancelers = [];

  tasks.forEach((task, i) => {
    const initialTimer = setTimeoutFn(() => {
      limiter.run(task);
      const intervalTimer = setIntervalFn(() => limiter.run(task), windowMs);
      cancelers.push(() => clearIntervalFn(intervalTimer));
    }, offsets[i]);
    cancelers.push(() => clearTimeoutFn(initialTimer));
  });

  return { stop: () => cancelers.forEach((cancel) => cancel()), limiter };
}

module.exports = { computeStaggeredOffsets, createConcurrencyLimiter, scheduleStaggered };

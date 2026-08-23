const test = require("node:test");
const assert = require("node:assert/strict");
const { computeStaggeredOffsets, createConcurrencyLimiter, scheduleStaggered } = require("../../lib/collectors/requestScheduler");

test("computeStaggeredOffsets: distribui uniformemente dentro da janela", () => {
  assert.deepEqual(computeStaggeredOffsets(4, 1000), [0, 250, 500, 750]);
});

test("computeStaggeredOffsets: 1 tarefa começa em 0", () => {
  assert.deepEqual(computeStaggeredOffsets(1, 1000), [0]);
});

test("computeStaggeredOffsets: 0 tarefas devolve array vazio", () => {
  assert.deepEqual(computeStaggeredOffsets(0, 1000), []);
});

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("createConcurrencyLimiter: nunca deixa mais que maxConcurrent em voo ao mesmo tempo", async () => {
  const limiter = createConcurrencyLimiter(2);
  let activeCountObserved = 0;
  let maxActiveObserved = 0;

  const deferreds = [createDeferred(), createDeferred(), createDeferred(), createDeferred()];
  const runPromises = deferreds.map((d) =>
    limiter.run(async () => {
      activeCountObserved++;
      maxActiveObserved = Math.max(maxActiveObserved, activeCountObserved);
      await d.promise;
      activeCountObserved--;
    })
  );

  // `limiter.run` inicia a execução de forma assíncrona (via microtask) --
  // um tick garante que as 2 primeiras já foram aceitas antes de checar.
  await Promise.resolve();
  assert.equal(limiter.activeCount, 2);
  assert.equal(limiter.queuedCount, 2);

  deferreds[0].resolve();
  deferreds[1].resolve();
  await Promise.all([runPromises[0], runPromises[1]]);

  deferreds[2].resolve();
  deferreds[3].resolve();
  await Promise.all([runPromises[2], runPromises[3]]);

  assert.equal(maxActiveObserved, 2);
});

test("createConcurrencyLimiter: propaga erro de uma tarefa sem travar as seguintes", async () => {
  const limiter = createConcurrencyLimiter(1);
  const failing = limiter.run(() => Promise.reject(new Error("boom")));
  const succeeding = limiter.run(() => Promise.resolve("ok"));

  await assert.rejects(failing, /boom/);
  assert.equal(await succeeding, "ok");
});

test("scheduleStaggered: dispara cada tarefa uma vez após seu offset", (t, done) => {
  const calls = [];
  // janela de 200ms, offsets [0, 100] -- checa em 30ms (só o offset 0 já
  // disparou; o offset 100 e a repetição do offset 0 ainda não chegaram),
  // evita falso positivo por causa da repetição do setInterval.
  const tasks = [() => calls.push("a"), () => calls.push("b")];
  const scheduler = scheduleStaggered(tasks, 200, { maxConcurrent: 2 });

  setTimeout(() => {
    assert.deepEqual(calls, ["a"]);
    scheduler.stop();
    done();
  }, 30);
});

test("scheduleStaggered: stop() cancela a repetição -- nenhuma chamada depois disso", (t, done) => {
  const calls = [];
  const scheduler = scheduleStaggered([() => calls.push("tick")], 10, { maxConcurrent: 1 });

  setTimeout(() => {
    scheduler.stop();
    const countAfterStop = calls.length;
    setTimeout(() => {
      assert.equal(calls.length, countAfterStop, "não deveria haver chamadas depois do stop()");
      done();
    }, 50);
  }, 15);
});

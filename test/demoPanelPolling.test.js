// Testa createDemoPoller (public/dashboard/demo-panel.js) -- núcleo PURO de
// agendamento/concorrência do painel Demo, sem DOM (jsdom não é dependência
// deste projeto). fetchImpl/timers são sempre injetados, nunca globais reais
// -- nenhuma rede de verdade, nenhum timer de verdade. A parte de
// renderização (buildPanelBody/renderDemo) só roda quando `typeof document
// !== "undefined"`, então nunca executa aqui (ambiente Node puro) -- só
// createDemoPoller é exercitado.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDemoPoller } = require("../public/dashboard/demo-panel.js");
const fs = require("fs");
const path = require("path");

// Harness de timer falso -- setIntervalImpl grava (id -> callback) num Map
// exposto ao teste; fireAll() dispara manualmente cada callback registrado,
// sem depender de nenhuma API de timer real/mock específica de versão do
// Node. activeCount() prova "só um timer ativo" de forma direta.
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setIntervalImpl: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearIntervalImpl: (id) => {
      timers.delete(id);
    },
    fireAll: () => {
      for (const fn of [...timers.values()]) fn();
    },
    activeCount: () => timers.size,
  };
}

// fetchImpl controlável -- cada chamada gera uma promise que o teste resolve/
// rejeita manualmente (nunca resolve sozinha), pra poder inspecionar o
// estado EXATO enquanto uma consulta está pendente.
function controllableFetch() {
  const calls = [];
  let pending = null;
  const impl = (path, opts) => {
    calls.push({ path, opts });
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  return {
    impl,
    calls,
    resolveLast: (body) => {
      const p = pending;
      pending = null;
      p.resolve(body);
    },
    rejectLast: (err) => {
      const p = pending;
      pending = null;
      p.reject(err);
    },
  };
}

async function flush() {
  // deixa a microtask queue (await dentro de tick()) drenar antes de
  // continuar o teste -- sem isso, asserções logo após resolveLast/fireAll
  // rodariam antes do `.then`/`await` interno terminar.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const OK_BODY = { success: true, data: { environment: "BYBIT DEMO — OBSERVAÇÃO" }, dataAge: 1000 };

test("createDemoPoller: carrega imediatamente ao montar, sem esperar o intervalo", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  assert.equal(f.calls.length, 1, "deveria ter chamado fetch imediatamente, sem esperar setInterval");
});

test("createDemoPoller: nova atualização depois do intervalo (5s default)", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  f.resolveLast(OK_BODY);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(updates.length, 1);

  timers.fireAll(); // simula os 5s se passando
  await flush();
  assert.equal(f.calls.length, 2, "o tick do intervalo deveria ter disparado uma nova consulta");
});

test("createDemoPoller: NUNCA inicia nova consulta enquanto a anterior está pendente", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  createDemoPoller({ fetchImpl: f.impl, onUpdate: () => {}, setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  assert.equal(f.calls.length, 1);

  // Intervalo dispara duas vezes seguidas ENQUANTO a primeira consulta
  // ainda não resolveu -- nenhuma delas deveria gerar uma segunda chamada.
  timers.fireAll();
  await flush();
  timers.fireAll();
  await flush();
  assert.equal(f.calls.length, 1, "nenhuma consulta nova deveria ter sido iniciada enquanto a primeira está pendente");

  f.resolveLast(OK_BODY);
  await flush();
  timers.fireAll();
  await flush();
  assert.equal(f.calls.length, 2, "depois que a pendente resolve, o próximo tick pode iniciar uma nova");
});

test("createDemoPoller: navegação repetida nunca deixa mais de um timer ativo", async () => {
  const f1 = controllableFetch();
  const t1 = fakeTimers();
  const poller1 = createDemoPoller({ fetchImpl: f1.impl, onUpdate: () => {}, setIntervalImpl: t1.setIntervalImpl, clearIntervalImpl: t1.clearIntervalImpl });
  await flush();
  assert.equal(t1.activeCount(), 1, "deveria existir exatamente 1 timer ativo após montar");

  // Simula "sair da seção" (app.js chama o cleanup devolvido por renderDemo
  // ANTES de montar a próxima).
  poller1.stop();
  assert.equal(t1.activeCount(), 0, "stop() deveria limpar o timer imediatamente");

  // "Reentrar" na seção cria um poller NOVO (novo mount) -- só ele deveria
  // ter timer ativo.
  const f2 = controllableFetch();
  const t2 = fakeTimers();
  createDemoPoller({ fetchImpl: f2.impl, onUpdate: () => {}, setIntervalImpl: t2.setIntervalImpl, clearIntervalImpl: t2.clearIntervalImpl });
  await flush();
  assert.equal(t1.activeCount(), 0, "o timer do mount antigo continua limpo");
  assert.equal(t2.activeCount(), 1, "só o mount novo tem timer ativo");
});

test("createDemoPoller: stop() limpa o timer e cancela a requisição pendente (limpeza ao desmontar)", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  const poller = createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  assert.equal(timers.activeCount(), 1);

  poller.stop();
  assert.equal(timers.activeCount(), 0, "timer precisa ser limpo no stop()");

  timers.fireAll(); // não deveria fazer nada -- não há mais timer, mas testa que fireAll em cima de um Map vazio não quebra
  await flush();
  assert.equal(f.calls.length, 1, "nenhuma consulta nova depois do stop()");
});

test("createDemoPoller: resposta atrasada (resolvida DEPOIS do stop()) nunca sobrescreve o estado -- onUpdate nunca é chamado com ela", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  const poller = createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  assert.equal(f.calls.length, 1);

  poller.stop(); // desmonta ENQUANTO a consulta ainda está em voo
  f.resolveLast(OK_BODY); // a resposta atrasada chega depois
  await flush();

  assert.equal(updates.length, 0, "uma resposta que chega depois do desmonte nunca deveria ser aplicada");
});

test("createDemoPoller: erro de rede -> onUpdate({data:null, error}), nunca reaproveita o último data bem-sucedido", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  f.resolveLast(OK_BODY);
  await flush();
  assert.equal(updates.length, 1);
  assert.ok(updates[0].data, "primeiro tick deveria ter sucesso");
  assert.ok(updates[0].lastSuccessAt);

  timers.fireAll();
  await flush();
  f.rejectLast(new Error("Failed to fetch"));
  await flush();

  assert.equal(updates.length, 2);
  assert.equal(updates[1].data, null, "erro nunca reaproveita o data antigo -- precisa ser null explicitamente");
  assert.equal(updates[1].error, "Failed to fetch");
  assert.ok(updates[1].lastAttemptAt, "última tentativa precisa estar marcada mesmo em erro");
  assert.equal(updates[1].lastSuccessAt, updates[0].lastSuccessAt, "lastSuccessAt do sucesso anterior é preservado (nunca apagado por um erro seguinte)");
});

test("createDemoPoller: recuperação automática -- depois de um erro, o próximo tick bem-sucedido volta a aplicar dado fresco sem reload", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  f.rejectLast(new Error("Failed to fetch"));
  await flush();
  assert.equal(updates[0].data, null);

  timers.fireAll();
  await flush();
  f.resolveLast(OK_BODY);
  await flush();

  assert.equal(updates.length, 2);
  assert.ok(updates[1].data, "depois da recuperação, o data volta a ser aplicado normalmente");
  assert.equal(updates[1].error, null);
});

test("createDemoPoller: nenhuma exceção não tratada -- corpo de resposta malformado (success ausente) vira erro tratado, nunca lança pro chamador", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  const updates = [];
  createDemoPoller({ fetchImpl: f.impl, onUpdate: (r) => updates.push(r), setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  f.resolveLast({ success: false, error: "banco indisponível" });
  await flush();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data, null);
  assert.equal(updates[0].error, "banco indisponível");
});

test("createDemoPoller: URL usada é o path relativo puro, nunca um host/porta hardcoded (funciona igual em 4300 e 4301)", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  createDemoPoller({ fetchImpl: f.impl, onUpdate: () => {}, setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, "/api/v1/demo");
  assert.ok(!f.calls[0].path.includes("://"), "path precisa ser relativo -- sem protocolo/host/porta embutidos");
  assert.ok(!f.calls[0].path.includes("4300"), "nunca porta 4300 hardcoded");
});

test("createDemoPoller: nenhuma rota mutável é chamada -- só /api/v1/demo, em toda a vida do poller (múltiplos ticks)", async () => {
  const f = controllableFetch();
  const timers = fakeTimers();
  createDemoPoller({ fetchImpl: f.impl, onUpdate: () => {}, setIntervalImpl: timers.setIntervalImpl, clearIntervalImpl: timers.clearIntervalImpl });
  await flush();
  f.resolveLast(OK_BODY);
  await flush();
  timers.fireAll();
  await flush();
  f.resolveLast(OK_BODY);
  await flush();

  assert.ok(f.calls.length >= 2);
  for (const call of f.calls) {
    assert.equal(call.path, "/api/v1/demo", "toda chamada precisa ser a mesma rota de leitura -- nunca uma rota de ordem/leverage/stop/cancelamento/fundos");
  }
});

test("demo-panel.js (fonte): nunca referencia nenhuma função/rota mutável da Bybit no arquivo inteiro (defesa estática, além do teste de comportamento acima)", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard", "demo-panel.js"), "utf8");
  // "ARMED_DEMO" (o literal) fica de fora desta lista de propósito -- já
  // existia antes desta rodada como RÓTULO de exibição
  // (`data.newExposureArmed ? "ARMED_DEMO" : ...`), nunca uma chamada de
  // função. "armDemo" (a função que de fato arma o kill switch,
  // lib/killSwitch.js) é o que precisa estar ausente, e está.
  for (const forbidden of ["placeOrder", "setLeverage", "setTradingStop", "cancelOrder", "cancelAllOrders", "applyDemoFunds", "privatePost", "armDemo(", "localhost:4300", "127.0.0.1:4300"]) {
    assert.ok(!source.includes(forbidden), `demo-panel.js não deveria conter "${forbidden}"`);
  }
});

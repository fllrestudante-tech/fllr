const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ALL_CHILDREN,
  VALID_PROFILES,
  SupervisorProfileError,
  resolveSupervisorProfile,
  selectSupervisedChildren,
} = require("../lib/supervisorProfile");

test("ALL_CHILDREN: nenhum nome duplicado na lista canônica", () => {
  const names = ALL_CHILDREN.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("ALL_CHILDREN: nenhum script duplicado na lista canônica -- dois nomes nunca apontam pro mesmo processo", () => {
  const scripts = ALL_CHILDREN.map((c) => c.script);
  assert.equal(new Set(scripts).size, scripts.length);
});

test("VALID_PROFILES: hoje só 'safe' existe -- nenhum perfil operacional com bot foi criado ainda", () => {
  assert.deepEqual(VALID_PROFILES, ["safe"]);
});

test("resolveSupervisorProfile: SUPERVISOR_PROFILE ausente -> 'safe'", () => {
  assert.equal(resolveSupervisorProfile({}), "safe");
});

test("resolveSupervisorProfile: SUPERVISOR_PROFILE vazio -> 'safe'", () => {
  assert.equal(resolveSupervisorProfile({ SUPERVISOR_PROFILE: "" }), "safe");
});

test("resolveSupervisorProfile: SUPERVISOR_PROFILE='safe' explícito -> 'safe'", () => {
  assert.equal(resolveSupervisorProfile({ SUPERVISOR_PROFILE: "safe" }), "safe");
});

test("resolveSupervisorProfile: valor não reconhecido lança SupervisorProfileError (falha fechada e explícita, nunca degrada silenciosamente)", () => {
  for (const value of ["production", "full", "Safe", "SAFE", "trading", "1"]) {
    assert.throws(() => resolveSupervisorProfile({ SUPERVISOR_PROFILE: value }), SupervisorProfileError, `valor "${value}" deveria lançar`);
  }
});

test("resolveSupervisorProfile: mensagem de erro nomeia o valor recebido e os valores aceitos, sem segredo nenhum envolvido", () => {
  assert.throws(() => resolveSupervisorProfile({ SUPERVISOR_PROFILE: "producao-tudo-ligado" }), (err) => {
    assert.ok(err.message.includes("producao-tudo-ligado"));
    assert.ok(err.message.includes("safe"));
    assert.equal(err.code, "SUPERVISOR_PROFILE_INVALID");
    return true;
  });
});

test("selectSupervisedChildren('safe'): NUNCA inclui 'bot' -- prova direta do requisito central desta rodada", () => {
  const { children } = selectSupervisedChildren("safe", {});
  assert.equal(children.some((c) => c.name === "bot"), false);
});

test("selectSupervisedChildren('safe'): lista exata dos processos seguros esperados (sem knowledge_collector, dependências ausentes)", () => {
  const { children, skipped } = selectSupervisedChildren("safe", {});
  const names = children.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "backup_daemon",
    "btc_dominance_collector",
    "bybit_collector",
    "dashboard_server",
    "fear_greed_collector",
    "metrics_sampler",
  ]);
  assert.ok(skipped.some((s) => s.name === "bot"));
  assert.ok(skipped.some((s) => s.name === "knowledge_collector"));
});

test("selectSupervisedChildren('safe'): knowledge_collector entra quando as duas dependências estão presentes", () => {
  const { children, skipped } = selectSupervisedChildren("safe", { FRED_API_KEY: "fake-nao-real", COINMARKETCAL_API_KEY: "fake-nao-real" });
  assert.ok(children.some((c) => c.name === "knowledge_collector"));
  assert.equal(skipped.some((s) => s.name === "knowledge_collector"), false);
});

test("selectSupervisedChildren('safe'): knowledge_collector fica de fora com diagnóstico estável quando só UMA das duas chaves está presente", () => {
  const { children, skipped } = selectSupervisedChildren("safe", { FRED_API_KEY: "fake-nao-real" });
  assert.equal(children.some((c) => c.name === "knowledge_collector"), false);
  const skip = skipped.find((s) => s.name === "knowledge_collector");
  assert.ok(skip);
  assert.equal(skip.reason, "dependência de configuração ausente");
});

test("selectSupervisedChildren('safe'): componente opcional ausente nunca derruba os demais -- o resto do perfil seguro continua completo", () => {
  const { children } = selectSupervisedChildren("safe", {}); // sem nenhuma env var
  assert.equal(children.length, 6); // os 6 processos seguros sem dependência opcional
  assert.ok(children.every((c) => typeof c.script === "string" && c.script.length > 0));
});

test("selectSupervisedChildren: nenhuma duplicação de filhos na saída (nome nem script), mesmo variando o env", () => {
  const { children } = selectSupervisedChildren("safe", { FRED_API_KEY: "x", COINMARKETCAL_API_KEY: "x" });
  const names = children.map((c) => c.name);
  const scripts = children.map((c) => c.script);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(scripts).size, scripts.length);
});

test("selectSupervisedChildren: perfil não reconhecido lança (defesa em profundidade -- mesmo chamado direto, sem passar por resolveSupervisorProfile antes)", () => {
  assert.throws(() => selectSupervisedChildren("producao-tudo-ligado", {}), SupervisorProfileError);
});

test("fluxo completo: SUPERVISOR_PROFILE inválido nunca resulta numa lista com 'bot' -- ou lança antes de chegar lá, ou (se alguém chamasse selectSupervisedChildren direto) também lança", () => {
  assert.throws(() => {
    const profile = resolveSupervisorProfile({ SUPERVISOR_PROFILE: "producao-tudo-ligado" });
    selectSupervisedChildren(profile, {});
  }, SupervisorProfileError);
});

test("ALL_CHILDREN: 'bot' é a única entrada category='trading' -- todo o resto é 'safe' (garante que a lista canônica não tem uma segunda porta pro trading)", () => {
  const tradingEntries = ALL_CHILDREN.filter((c) => c.category === "trading");
  assert.deepEqual(tradingEntries.map((c) => c.name), ["bot"]);
});

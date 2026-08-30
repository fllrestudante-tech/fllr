// Painel do perfil Demo -- arquivo SEPARADO de app.js (mantido assim desde a
// rodada anterior, pra minimizar risco no dashboard que já está em produção
// sob o perfil safe). Reaproveita as funções utilitárias globais já
// definidas por app.js (fetchJson/el/card/table/sectionTitle/dataAgeLine/
// fmtPct/fmtNum/fmtUsd/fmtDate/API_BASE/SECTIONS) -- este script precisa ser
// carregado DEPOIS de app.js no HTML. Só leitura local (via /api/v1/demo, ver
// lib/webDashboard/demoReader.js) -- nunca chama a Bybit/Telegram/
// AgentRouter, nunca envia nada, nunca chama uma rota mutável.
//
// createDemoPoller -- núcleo PURO de agendamento/concorrência, sem nenhuma
// referência a document/window/fetch direto (só recebe fetchImpl/timers
// injetados). Só por isso dá pra testar com node:test sem precisar de DOM
// (jsdom não é dependência deste projeto -- não foi adicionada nesta
// rodada). `module.exports` só existe quando `module` existe (Node,
// test/demoPanelPolling.test.js) -- no navegador (script solto, sem bundler)
// `typeof module` é "undefined" e este bloco nunca roda, então não há
// nenhum efeito colateral em produção.
//
// Contrato de concorrência (Bloqueador desta rodada -- painel Demo tinha
// zero atualização automática antes):
//   - carrega imediatamente ao montar, depois a cada `intervalMs` (5s);
//   - NUNCA inicia uma nova consulta enquanto a anterior está pendente
//     (`pendingController` -- um único fetch em voo por vez, sempre);
//   - token de sequência (`requestSeq`/`mySeq`) -- segunda camada, redundante
//     com o guard acima mas exigida explicitamente: uma resposta que chegasse
//     fora de ordem NUNCA sobrescreveria um estado mais novo;
//   - `stop()` cancela o fetch em voo (AbortController, quando disponível) e
//     limpa o timer -- chamado no desmonte da seção (ver app.js::showSection,
//     que agora chama o cleanup devolvido por renderDemo ANTES de trocar de
//     seção) e também autodetectado via `isMounted()` (fallback caso
//     showSection não seja quem desmontou, ex.: reentrada rápida);
//   - erro de rede/parse NUNCA aplica dado antigo como se fosse atual --
//     `onUpdate` recebe `{ data: null, error }` explicitamente, nunca reusa
//     silenciosamente o último `data` bem-sucedido.
function createDemoPoller({
  fetchImpl,
  onUpdate,
  isMounted = () => true,
  intervalMs = 5000,
  setIntervalImpl = typeof setInterval !== "undefined" ? setInterval : null,
  clearIntervalImpl = typeof clearInterval !== "undefined" ? clearInterval : null,
  nowFn = Date.now,
  urlPath = "/api/v1/demo",
} = {}) {
  let timerId = null;
  let pendingController = null;
  let requestSeq = 0;
  let lastSuccessAt = null;
  let lastAttemptAt = null;
  let stopped = false;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timerId != null && clearIntervalImpl) {
      clearIntervalImpl(timerId);
      timerId = null;
    }
    if (pendingController) {
      try {
        pendingController.abort();
      } catch {
        // best-effort -- alguns ambientes de teste não implementam abort()
      }
      pendingController = null;
    }
  }

  async function tick() {
    if (stopped) return;
    if (!isMounted()) {
      stop();
      return;
    }
    if (pendingController) return; // guard -- nunca duas consultas em voo ao mesmo tempo

    const mySeq = ++requestSeq;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    pendingController = controller;
    lastAttemptAt = nowFn();

    let outcome;
    try {
      const body = await fetchImpl(urlPath, controller ? { signal: controller.signal } : {});
      if (!body || body.success !== true) throw new Error((body && body.error) || "erro desconhecido");
      outcome = { data: body.data, dataAge: body.dataAge ?? null, error: null };
    } catch (err) {
      if (err && err.name === "AbortError") {
        // cancelado por stop() -- nunca é reportado como erro, nunca aplica
        pendingController = null;
        return;
      }
      outcome = { data: null, dataAge: null, error: (err && err.message) || "erro de rede" };
    }
    pendingController = null;

    // Token de sequência -- redundante com o guard acima (que já impede
    // sobreposição), mas exigido explicitamente como segunda camada: uma
    // resposta atrasada de uma consulta superada nunca sobrescreve.
    if (mySeq !== requestSeq) return;
    if (stopped || !isMounted()) return; // desmontado enquanto a consulta estava em voo

    if (outcome.error === null) lastSuccessAt = nowFn();
    onUpdate({ ...outcome, lastSuccessAt, lastAttemptAt });
  }

  function start() {
    tick(); // carregamento imediato, sem esperar o primeiro intervalo
    if (setIntervalImpl) {
      timerId = setIntervalImpl(() => {
        if (!isMounted()) {
          stop();
          return;
        }
        tick();
      }, intervalMs);
    }
  }

  start();
  return { stop, _tick: tick };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createDemoPoller };
}

// ---------------------------------------------------------------------
// Renderização (só roda no navegador -- document/el/card/table/etc. só
// existem lá; test/demoPanelPolling.test.js nunca chama nada abaixo desta
// linha, só createDemoPoller acima).
// ---------------------------------------------------------------------
if (typeof document !== "undefined") {
  (function () {
    function statusBar({ error, lastSuccessAt, lastAttemptAt }) {
      const parts = [
        el("span", {}, `Última atualização bem-sucedida: ${lastSuccessAt ? fmtDate(new Date(lastSuccessAt).toISOString()) : "nunca"}`),
        el("span", {}, `Última tentativa: ${lastAttemptAt ? fmtDate(new Date(lastAttemptAt).toISOString()) : "—"}`),
      ];
      const bar = el("div", { class: "data-age" }, parts);
      if (error) {
        bar.appendChild(el("span", { class: "card-value negative" }, ` · indisponível: ${error}`));
      }
      return bar;
    }

    // Corpo completo do painel -- EXATAMENTE o mesmo conteúdo/campos de
    // antes desta rodada, só extraído pra função reutilizável (chamada a
    // cada atualização bem-sucedida, nunca com dado velho/fabricado).
    function buildPanelBody(root, data, dataAge) {
      root.appendChild(sectionTitle(data.environment));
      const age = dataAgeLine(dataAge);
      if (age) root.appendChild(age);

      root.appendChild(
        el("div", { class: "card-grid" }, [
          card("Modo de execução", data.executionMode ? data.executionMode.toUpperCase() : "indisponível", { cls: data.executionMode === "observe" ? "positive" : data.executionMode === "execution" ? "negative" : "" }),
          card("Configurado", data.configured ? "sim" : "não", { cls: data.configured ? "positive" : "negative" }),
          card("Leitura privada", data.privateReadEnabled ? "habilitada" : "desabilitada"),
          card("Nova exposição armada", data.newExposureArmed ? "ARMED_DEMO" : data.killSwitchState, { cls: data.newExposureArmed ? "negative" : "positive" }),
          card("Saída de emergência disponível", data.emergencyExitAvailable ? "sim" : "não", { cls: data.emergencyExitAvailable ? "positive" : "negative" }),
          card("Gate de ordens (TRADING_EXECUTION_ENABLED)", data.tradingExecutionEnabled ? "LIGADO" : "desligado", { cls: data.tradingExecutionEnabled ? "negative" : "positive" }),
          card("Dado fresco", data.dataFresh ? "sim" : "stale/unavailable", {
            sub: data.lastSuccessfulPrivateReadAt ? `última leitura: ${fmtDate(data.lastSuccessfulPrivateReadAt)}` : "nenhuma leitura privada bem-sucedida ainda",
            cls: data.dataFresh ? "positive" : "negative",
          }),
        ])
      );

      root.appendChild(sectionTitle("Conta Demo / instrumento"));
      root.appendChild(
        table(
          ["Campo", "Valor"],
          [
            ["Snapshot", data.snapshotStatus ? data.snapshotStatus.status : "indisponível"],
            ["Equity Demo", data.snapshotStatus && data.snapshotStatus.equityUsd != null ? fmtUsd(data.snapshotStatus.equityUsd) : "indisponível"],
            ["Exposição", data.snapshotStatus && data.snapshotStatus.exposureUsd != null ? fmtUsd(data.snapshotStatus.exposureUsd) : "indisponível"],
            ["Posição real (size>0)?", data.symbolState ? (data.symbolState.hasOpenPosition ? `${data.symbolState.side} qty=${data.symbolState.qty}` : "não") : "indisponível"],
            ["Ordens abertas", data.snapshotStatus && data.snapshotStatus.openOrdersCount != null ? String(data.snapshotStatus.openOrdersCount) : "indisponível"],
            ["Leverage efetiva", data.symbolState && data.symbolState.effectiveLeverage != null ? `${data.symbolState.effectiveLeverage}x` : "indisponível"],
            ["Modo de margem / posição", data.symbolState ? `${data.symbolState.tradeModeLabel} / ${data.symbolState.positionModeLabel}` : "indisponível"],
            ["PnL não realizado", data.symbolState && data.symbolState.hasOpenPosition ? "ver posição acima (Bybit não devolve PnL fora de posição aberta)" : "indisponível (sem posição aberta)"],
            ["qtyStep / minOrderQty / tickSize", data.instrumentInfo ? `${data.instrumentInfo.qtyStep} / ${data.instrumentInfo.minOrderQty} / ${data.instrumentInfo.tickSize}` : "indisponível"],
            ["minNotionalValue", data.instrumentInfo && data.instrumentInfo.minNotionalValue != null ? `$${data.instrumentInfo.minNotionalValue}` : "indisponível"],
          ]
        )
      );

      root.appendChild(sectionTitle("Análise e decisão hipotética (modo observe)"));
      root.appendChild(
        table(
          ["Campo", "Valor"],
          [
            ["Última análise", data.lastAnalysis ? `${data.lastAnalysis.signal} @ ${fmtNum(data.lastAnalysis.price)} (${(data.lastAnalysis.reasons || []).join(", ") || "—"})` : "indisponível"],
            ["Regime", data.lastAnalysis ? data.lastAnalysis.regime || "—" : "indisponível"],
            ["Em", data.lastAnalysis ? fmtDate(data.lastAnalysis.at) : "—"],
            [
              "Última decisão hipotética",
              data.lastHypotheticalDecision
                ? `${data.lastHypotheticalDecision.kind} -- ${data.lastHypotheticalDecision.wouldTrade ? "executaria" : "NÃO executaria"}${data.lastHypotheticalDecision.side ? ` (${data.lastHypotheticalDecision.side}${data.lastHypotheticalDecision.qty ? ` qty=${data.lastHypotheticalDecision.qty}` : ""})` : ""}`
                : "indisponível",
            ],
            ["Motivo (nenhuma ordem foi enviada)", data.lastHypotheticalDecision ? data.lastHypotheticalDecision.blockReason || "execução desligada (modo observe)" : "indisponível"],
          ]
        )
      );

      if (data.lastDecision) {
        root.appendChild(sectionTitle("Última decisão do gate"));
        root.appendChild(
          table(
            ["Campo", "Valor"],
            [
              ["Permitida?", data.lastDecision.allowed ? "sim" : "não"],
              ["Tipo", data.lastDecision.kind || "—"],
              ["Operação", data.lastDecision.opName || "—"],
              ["Motivo do bloqueio", data.blockReason || "—"],
              ["Em", fmtDate(data.lastDecision.at)],
            ]
          )
        );
      }

      root.appendChild(sectionTitle("Limites de risco configurados"));
      if (data.riskLimits) {
        root.appendChild(
          table(
            ["Limite", "Valor"],
            [
              ["Símbolos permitidos", data.riskLimits.allowedSymbols.join(", ")],
              ["Notional máx/ordem", `$${data.riskLimits.maxNotionalUsdPerOrder}`],
              ["Leverage máx", `${data.riskLimits.maxLeverage}x`],
              ["Posições simultâneas máx", String(data.riskLimits.maxSimultaneousPositions)],
              ["Perda diária máx", fmtPct(data.riskLimits.dailyLossLimitPct)],
              ["Ordens máx/período", `${data.riskLimits.maxOrdersPerPeriod} / ${Math.round(data.riskLimits.orderPeriodMs / 60000)}min`],
              ["Cooldown entre ordens", `${Math.round(data.riskLimits.orderCooldownMs / 1000)}s`],
              ["Erros consecutivos máx (lockout)", String(data.riskLimits.maxConsecutiveErrors)],
              ["Perdas consecutivas máx (lockout)", String(data.riskLimits.maxConsecutiveLosses)],
              ["Stop-loss obrigatório", "sim (não configurável)"],
            ]
          )
        );
      } else {
        root.appendChild(el("div", { class: "card-sub" }, `configuração de limites inválida: ${data.riskLimitsError || "desconhecido"}`));
      }

      root.appendChild(sectionTitle("Estado de trading (local -- nunca consulta saldo/posição real na Bybit)"));
      root.appendChild(
        table(
          ["Campo", "Valor"],
          [
            ["Posição aberta?", data.trading.isOpened ? `${data.trading.side} qty=${data.trading.qty ?? "—"}` : "não"],
            ["Preço de entrada", data.trading.entryPrice != null ? fmtNum(data.trading.entryPrice) : "—"],
            ["Stop-loss", data.trading.stopLossPrice != null ? fmtNum(data.trading.stopLossPrice) : "—"],
            ["Take-profit", data.trading.takeProfitPrice != null ? fmtNum(data.trading.takeProfitPrice) : "—"],
            ["Perda diária acumulada", fmtPct(data.trading.dailyLoss)],
            ["Perdas consecutivas", String(data.trading.consecutiveLosses ?? 0)],
            ["Saldo (equity)", data.trading.balance != null ? fmtUsd(data.trading.balance) : "indisponível — dashboard nunca consulta a Bybit"],
            ["Última ordem", data.trading.lastTradeTime ? fmtDate(new Date(data.trading.lastTradeTime).toISOString()) : "nunca"],
          ]
        )
      );

      root.appendChild(sectionTitle("AgentRouter (shadow / read-only — nunca aprova ordem)"));
      const ai = data.trading.lastAiAssessment;
      root.appendChild(card("Status", data.agentRouterStatus === "shadow" ? "SHADOW" : "OFFLINE", { cls: data.agentRouterStatus === "shadow" ? "positive" : "" }));
      root.appendChild(
        table(
          ["Campo", "Valor"],
          ai
            ? [
                ["Última recomendação", ai.recommendation || "—"],
                ["Regime de mercado", ai.marketRegime || "—"],
                ["Nível de risco (IA)", ai.riskLevel || "—"],
                ["Provider / model", `${ai.provider || "—"} / ${ai.model || "—"}`],
                ["Em", fmtDate(ai.at)],
              ]
            : [["Última avaliação", "nenhuma registrada ainda"]]
        )
      );

      root.appendChild(sectionTitle("Supervisor — componentes"));
      root.appendChild(
        table(
          ["Componente", "Estado", "Reinícios"],
          data.supervisor
            ? Object.entries(data.supervisor.children).map(([name, s]) => [name, s.pid != null ? `PID ${s.pid}` : "parado", String(s.totalRestarts ?? 0)])
            : [["(nenhum)", "perfil demo nunca foi iniciado", "—"]]
        )
      );

      root.appendChild(sectionTitle("Telegram (somente leitura — sinal informativo, nunca vira comando)"));
      root.appendChild(card("Telegram", data.telegramStatus ? (data.telegramStatus.ok ? "READ-ONLY / OK" : "READ-ONLY / indisponível") : "OFFLINE", { sub: data.telegramStatus ? fmtDate(data.telegramStatus.updatedAt) : null, cls: data.telegramStatus && data.telegramStatus.ok ? "positive" : "" }));
    }

    // Chamado a cada resultado do poller (sucesso OU erro) -- erro NUNCA
    // reaproveita o último `data` bem-sucedido: a área de conteúdo mostra
    // "indisponível" explicitamente, nunca um número antigo como se fosse
    // atual (Bloqueador desta rodada, item "fail-closed e erros").
    function renderUpdate(root, result) {
      root.innerHTML = "";
      root.appendChild(statusBar(result));
      if (result.data) {
        buildPanelBody(root, result.data, result.dataAge);
      } else {
        root.appendChild(el("div", { class: "section-error" }, "Painel Demo indisponível — sem dado novo desde a última atualização bem-sucedida acima."));
      }
    }

    async function renderDemo(container) {
      container.innerHTML = "";
      const root = el("div", {});
      container.appendChild(root);

      function isMounted() {
        return root.isConnected;
      }

      const poller = createDemoPoller({
        // URL relativa à origem ATUAL (nunca host/porta fixos no código) --
        // funciona igual na porta do perfil safe e em qualquer porta
        // alternativa (ex.: 4301, teste isolado).
        fetchImpl: (path, opts) => fetch(new URL(path, location.origin), opts).then((res) => res.json()),
        onUpdate: (result) => renderUpdate(root, result),
        isMounted,
      });

      // Devolvido pra app.js::showSection chamar ANTES de desmontar esta
      // seção (ver app.js) -- limpeza determinística, sem depender só da
      // autodetecção via isConnected (que só é checada no próximo tick/
      // intervalo, com até `intervalMs` de atraso).
      return poller.stop;
    }

    SECTIONS.push({ id: "demo", label: "Demo", group: "Operações", render: renderDemo });
    // app.js já rodou buildNav("overview", ...) ANTES deste script carregar
    // (script externo, ordem de documento) -- sem isto, o item "Demo" só
    // apareceria depois do usuário clicar em outra seção pela primeira vez.
    // Refaz a nav com a lista completa, sem alterar o que já está em tela
    // ("overview" continua a seção ativa/exibida neste momento do boot).
    buildNav("overview", showSection);
  })();
}

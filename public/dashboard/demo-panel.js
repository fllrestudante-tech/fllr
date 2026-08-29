// Painel do perfil Demo -- arquivo SEPARADO de app.js de propósito (nunca
// editado nesta rodada, pra minimizar risco no dashboard que já está em
// produção sob o perfil safe). Reaproveita as funções utilitárias globais
// já definidas por app.js (fetchJson/el/card/table/sectionTitle/
// dataAgeLine/fmtPct/fmtNum/fmtUsd/fmtDate/API_BASE/SECTIONS) -- este
// script precisa ser carregado DEPOIS de app.js no HTML. Só leitura local
// (via /api/v1/demo, ver lib/webDashboard/demoReader.js) -- nunca chama a
// Bybit/Telegram/AgentRouter, nunca envia nada.
async function renderDemo(container) {
  const { data, dataAge } = await fetchJson(`${API_BASE}/demo`);

  container.innerHTML = "";
  container.appendChild(sectionTitle("Perfil Demo — acompanhamento em tempo real"));
  const age = dataAgeLine(dataAge);
  if (age) container.appendChild(age);

  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Ambiente", data.environment, { cls: data.environment === "BYBIT DEMO" ? "positive" : "" }),
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

  if (data.lastDecision) {
    container.appendChild(sectionTitle("Última decisão do gate"));
    container.appendChild(
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

  container.appendChild(sectionTitle("Limites de risco configurados"));
  if (data.riskLimits) {
    container.appendChild(
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
    container.appendChild(el("div", { class: "card-sub" }, `configuração de limites inválida: ${data.riskLimitsError || "desconhecido"}`));
  }

  container.appendChild(sectionTitle("Estado de trading (local -- nunca consulta saldo/posição real na Bybit)"));
  container.appendChild(
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

  container.appendChild(sectionTitle("AgentRouter (shadow / read-only — nunca aprova ordem)"));
  const ai = data.trading.lastAiAssessment;
  container.appendChild(
    table(
      ["Campo", "Valor"],
      ai
        ? [
            ["Última recomendação", ai.recommendation || "—"],
            ["Regime de mercado", ai.marketRegime || "—"],
            ["Nível de risco (IA)", ai.riskLevel || "—"],
            ["Em", fmtDate(ai.at)],
          ]
        : [["Última avaliação", "nenhuma registrada ainda"]]
    )
  );

  container.appendChild(sectionTitle("Supervisor — componentes"));
  container.appendChild(
    table(
      ["Componente", "Estado", "Reinícios"],
      data.supervisor
        ? Object.entries(data.supervisor.children).map(([name, s]) => [name, s.pid != null ? `PID ${s.pid}` : "parado", String(s.totalRestarts ?? 0)])
        : [["(nenhum)", "perfil demo nunca foi iniciado", "—"]]
    )
  );

  container.appendChild(sectionTitle("Telegram"));
  container.appendChild(card("Telegram (somente leitura)", data.telegramStatus ? (data.telegramStatus.ok ? "ok" : "indisponível") : "sem dado", { sub: data.telegramStatus ? fmtDate(data.telegramStatus.updatedAt) : null }));
}

SECTIONS.push({ id: "demo", label: "Demo", group: "Operações", render: renderDemo });
// app.js já rodou buildNav("overview", ...) ANTES deste script carregar
// (script externo, ordem de documento) -- sem isto, o item "Demo" só
// apareceria depois do usuário clicar em outra seção pela primeira vez.
// Refaz a nav com a lista completa, sem alterar o que já está em tela
// ("overview" continua a seção ativa/exibida neste momento do boot).
buildNav("overview", showSection);

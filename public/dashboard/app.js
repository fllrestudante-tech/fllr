// Dashboard Operacional -- vanilla JS, sem framework/build step. Cada seção
// busca só sua própria rota (carregamento independente); o Header faz
// polling simples a cada alguns segundos, separado da navegação.
const API_BASE = "/api/v1";
const HEADER_POLL_MS = 5000;

const SECTIONS = [
  { id: "overview", label: "Overview", group: "Operações", render: renderOverview },
  { id: "trading", label: "Trading", group: "Operações", render: renderTrading },
  { id: "assets", label: "Assets", group: "Mercado", render: renderAssets },
  { id: "features", label: "Features", group: "Mercado", render: renderFeatures },
  { id: "collectors", label: "Collectors", group: "Mercado", render: renderCollectors },
  { id: "replay", label: "Replay", group: "Pesquisa", render: renderReplay },
  { id: "research", label: "Research", group: "Pesquisa", render: renderResearch },
];

async function fetchJson(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!body.success) throw new Error(body.error || "erro desconhecido");
  return body;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function fmtPct(n, digits = 1) {
  return typeof n === "number" ? `${(n * 100).toFixed(digits)}%` : "—";
}
function fmtNum(n, digits = 2) {
  return typeof n === "number" ? n.toFixed(digits) : "—";
}
function fmtUsd(n) {
  return typeof n === "number" ? `${n >= 0 ? "+" : ""}$${n.toFixed(2)}` : "—";
}
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString("pt-BR") : "nunca";
}
function fmtAge(ms) {
  if (ms == null) return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)}s atrás`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}min atrás`;
  return `${Math.round(ms / 3600000)}h atrás`;
}

function card(label, value, { sub = null, cls = "" } = {}) {
  return el("div", { class: "card" }, [
    el("div", { class: "card-label" }, label),
    el("div", { class: `card-value ${cls}` }, String(value)),
    sub ? el("div", { class: "card-sub" }, sub) : null,
  ]);
}

function bar(pct) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  return el("div", { class: "bar-track" }, [el("div", { class: "bar-fill", style: `width:${clamped}%` })]);
}

function table(headers, rows) {
  return el("table", {}, [
    el("thead", {}, [el("tr", {}, headers.map((h) => el("th", {}, h)))]),
    el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, c))))),
  ]);
}

function sectionTitle(text) {
  return el("div", { class: "section-title" }, text);
}

function dataAgeLine(dataAge) {
  return dataAge != null ? el("div", { class: "data-age" }, `dado com ${fmtAge(dataAge)}`) : null;
}

// Nota fixa, não calculada -- não existe hoje coleta de preço de altcoin
// (Universe roda com 1 símbolo só, MARKET_SYMBOLS desligado) nem de índice
// (Nasdaq/DXY); o FRED só traz calendário de eventos macro, não série de
// preço. Enquanto isso não existir, é texto explicativo, não um número.
function marketReadingNote() {
  return el("div", { class: "note-box" }, [
    el("div", { class: "note-title" }, "Leitura de correlação com BTC (nota, não calculada)"),
    el(
      "p",
      {},
      "Nasdaq e altcoins historicamente NÃO se movem de forma inversa ao BTC — o padrão observado é o oposto: ambos tendem a acompanhar a direção do BTC (BTC se comporta como um ativo de risco correlacionado a tech/Nasdaq), com altcoins tipicamente amplificando o movimento do BTC na mesma direção (beta mais alto), não o contrário."
    ),
    el(
      "p",
      {},
      "O ativo mais citado com correlação historicamente inversa ao BTC é o Dólar Index (DXY): dólar forte costuma pressionar BTC pra baixo, e vice-versa."
    ),
    el(
      "p",
      { class: "card-sub" },
      "Sem dado real coletado ainda (candles de altcoin e índice de dólar/Nasdaq não fazem parte da coleta hoje) — este texto é fixo, não uma correlação calculada."
    ),
  ]);
}

// Candlestick, não linha (padrão do dashboard pra qualquer série de preço/
// capital) -- cada vela é 1 dia de capital acumulado: open/close = valor ao
// entrar/sair do dia, high/low = extremos atingidos no dia. Verde quando o
// dia fecha acima de onde abriu, vermelho quando fecha abaixo.
function equityCandleSvg(candles) {
  if (!candles || candles.length < 1) return el("div", { class: "card-sub" }, "sem trades suficientes pra curva de equity ainda");
  const width = 600;
  const height = 140;
  const padTop = 10;
  const padBottom = 10;
  const plotH = height - padTop - padBottom;

  const allValues = candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
  const min = Math.min(0, ...allValues);
  const max = Math.max(0, ...allValues);
  const range = max - min || 1;
  const y = (v) => padTop + plotH - ((v - min) / range) * plotH;

  const step = width / candles.length;
  const bodyW = Math.max(2, step * 0.6);

  const zeroY = y(0).toFixed(1);
  let bars = `<line x1="0" y1="${zeroY}" x2="${width}" y2="${zeroY}" stroke="#2a2e37" stroke-width="1" stroke-dasharray="3 3" />`;

  candles.forEach((c, i) => {
    const cx = step * i + step / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? "#2ecc71" : "#e74c3c";
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBottom = y(Math.min(c.open, c.close));
    const bodyH = Math.max(1.5, bodyBottom - bodyTop);
    bars += `<line x1="${cx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${color}" stroke-width="1" />`;
    bars += `<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" />`;
  });

  const svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${bars}</svg>`;
  return el("div", { html: svg });
}

// ---- Header (polling independente) ----

async function refreshHeader() {
  const container = document.getElementById("header-status");
  try {
    const { data, dataAge } = await fetchJson(`${API_BASE}/header`);
    const led = (status, label) => `<span class="led ${status}"></span>${label}`;
    container.innerHTML = [
      led(data.bot, "Bot"),
      led(data.collector, "Collector"),
      led(data.replay, "Replay"),
      led(data.marketDb, "Market DB"),
      led(data.exchangeConnected === "connected" ? "connected" : "disconnected", "Exchange"),
      led(data.circuitBreaker === "on" ? "on" : "connected", `Circuit Breaker: ${data.circuitBreaker}`),
      `Brains: ${data.brains}`,
      `Decision: ${data.decisionEngine}`,
      `Feature Builder: ${data.featureBuilder}`,
      dataAge != null ? `(${fmtAge(dataAge)})` : "",
    ]
      .map((s) => `<span>${s}</span>`)
      .join("");
  } catch (err) {
    container.textContent = `header indisponível: ${err.message}`;
  }
}

// ---- Overview ----

async function renderOverview(container) {
  const [overview, tradingAll, tradingToday] = await Promise.all([
    fetchJson(`${API_BASE}/overview`),
    fetchJson(`${API_BASE}/trading?window=all`),
    fetchJson(`${API_BASE}/trading?window=today`),
  ]);
  const o = overview.data;
  const m = tradingAll.data.metrics;
  const t = tradingToday.data.metrics;

  container.appendChild(dataAgeLine(overview.dataAge));

  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Profit Factor", fmtNum(m.profitFactor), { cls: m.profitFactor >= 1 ? "positive" : "negative", sub: `${m.totalTrades} trades (all-time)` }),
      card("Max Drawdown", fmtPct(m.maxDrawdown), { cls: "negative" }),
      card("PnL Total", fmtUsd(o.capital.totalPnlUsd), { cls: o.capital.totalPnlUsd >= 0 ? "positive" : "negative" }),
      card("Trades Hoje", t.totalTrades, { sub: `Win Rate ${fmtPct(t.winRate, 0)}` }),
    ])
  );

  container.appendChild(sectionTitle("Equity Curve"));
  container.appendChild(equityCandleSvg(tradingAll.data.equityCandles));

  container.appendChild(marketReadingNote());

  container.appendChild(sectionTitle("Risk"));
  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Kelly Fraction", o.risk.kellyFraction != null ? fmtNum(o.risk.kellyFraction, 3) : "—"),
      card("VaR 95%", o.risk.varCvar.var != null ? fmtPct(o.risk.varCvar.var) : "—"),
      card("CVaR 95%", o.risk.varCvar.cvar != null ? fmtPct(o.risk.varCvar.cvar) : "—"),
      card("Circuit Breaker", o.risk.circuitBreaker.active ? "ATIVO" : "off", { cls: o.risk.circuitBreaker.active ? "negative" : "" }),
    ])
  );

  container.appendChild(sectionTitle("Replay"));
  if (o.replay.available) {
    container.appendChild(
      el("div", { class: "card-grid" }, [
        card("Snapshots", `${o.replay.snapshotCount} / ${o.replay.snapshotTarget}`, { sub: `${o.replay.snapshotProgressPct}%` }),
        card("Decision Brain", o.replay.decisionBrainReady ? "READY" : "não pronto"),
      ])
    );
    container.appendChild(bar(o.replay.snapshotProgressPct));
  } else {
    container.appendChild(el("div", { class: "card-sub" }, o.replay.reason));
  }

  container.appendChild(sectionTitle("Posição Aberta"));
  if (o.position.open) {
    container.appendChild(
      table(
        ["Side", "Entrada", "Qty", "Stop", "Take", "Trailing", "Aberta em"],
        [[o.position.side, o.position.entryPrice, o.position.qty, o.position.stopLossPrice ?? "—", o.position.takeProfitPrice ?? "—", o.position.trailingActivated ? "sim" : "não", fmtDate(new Date(o.position.openedAt).toISOString())]]
      )
    );
  } else {
    container.appendChild(el("div", { class: "card-sub" }, "sem posição aberta"));
  }

  container.appendChild(sectionTitle("Timeline"));
  container.appendChild(
    el(
      "ul",
      { class: "timeline" },
      o.timeline.map((e) => el("li", {}, [el("span", { class: "t-time" }, fmtDate(e.time)), el("span", { class: "t-type" }, e.type), el("span", {}, e.summary)]))
    )
  );
}

// ---- Trading ----

async function renderTrading(container) {
  const windowSelect = el("select", { id: "trading-window" }, ["today", "7d", "30d", "90d", "all"].map((w) => el("option", { value: w }, w)));
  windowSelect.value = "all";
  container.appendChild(el("div", { class: "asset-picker" }, [el("label", {}, "Janela: "), windowSelect]));

  const body = el("div");
  container.appendChild(body);

  async function load(windowKey) {
    body.innerHTML = "carregando...";
    const { data, dataAge } = await fetchJson(`${API_BASE}/trading?window=${windowKey}`);
    body.innerHTML = "";
    const m = data.metrics;
    body.appendChild(dataAgeLine(dataAge));
    body.appendChild(
      el("div", { class: "card-grid" }, [
        card("Profit Factor", fmtNum(m.profitFactor)),
        card("Win Rate", fmtPct(m.winRate, 0)),
        card("Expectancy", fmtPct(m.expectancy)),
        card("Sharpe", fmtNum(m.sharpe)),
        card("Max Drawdown", fmtPct(m.maxDrawdown)),
        card("Trades", m.totalTrades),
        card("Sample Confidence", m.sampleConfidence ? `${m.sampleConfidence.status} (${m.sampleConfidence.pct}%)` : "—"),
      ])
    );
    if (data.exitAnalytics && Object.keys(data.exitAnalytics).length > 0) {
      body.appendChild(sectionTitle("Exit Analytics (motivo de saída)"));
      body.appendChild(
        table(
          ["Motivo", "Trades", "Win Rate", "PnL% total"],
          Object.entries(data.exitAnalytics).map(([reason, r]) => [reason, r.trades, fmtPct(r.winRate, 0), fmtPct(r.totalPnlPct)])
        )
      );
    }
    body.appendChild(sectionTitle("Lucro por dia"));
    body.appendChild(table(["Dia", "PnL", "Trades"], (data.lucroPorDia || []).slice(-14).map((d) => [d.period, fmtUsd(d.pnlUsd), d.trades])));
  }

  windowSelect.addEventListener("change", () => load(windowSelect.value));
  await load("all");
}

// ---- Assets (Explorer) ----

async function renderAssets(container) {
  const { data: symbols } = await fetchJson(`${API_BASE}/assets`);
  const select = el("select", {}, symbols.symbols.map((s) => el("option", { value: s }, s)));
  container.appendChild(el("div", { class: "asset-picker" }, [el("label", {}, "Símbolo: "), select]));

  const body = el("div");
  container.appendChild(body);

  async function load(symbol) {
    body.innerHTML = "carregando...";
    const { data, dataAge } = await fetchJson(`${API_BASE}/assets/${symbol}`);
    body.innerHTML = "";
    body.appendChild(dataAgeLine(dataAge));

    body.appendChild(sectionTitle("Identity"));
    body.appendChild(el("div", { class: "card-sub" }, data.identity ? `${data.identity.baseAsset}/${data.identity.quoteAsset} -- ${data.identity.sector || "sem setor"} -- ${data.identity.narrative || ""}` : "sem asset registrado ainda"));

    body.appendChild(sectionTitle("Coverage / Sanity"));
    body.appendChild(
      el("div", { class: "card-grid" }, [
        card("Coverage", data.coverage ? fmtPct(data.coverage.coveragePct / 100) : "—"),
        card("Sanity", data.sanity ? `${data.sanity.passRate}%` : "—"),
      ])
    );

    body.appendChild(sectionTitle("Features Ativas"));
    body.appendChild(
      table(
        ["Feature", "Estado", "Ativa", "Confidence", "Atualizado"],
        data.features.map((f) => [f.feature, f.interpretation.state, f.active ? "ON" : "off", `${f.confidence ?? "—"}%`, fmtDate(f.metadata?.computedAt)])
      )
    );

    body.appendChild(sectionTitle("Últimos Trades"));
    if (data.trades.available) {
      body.appendChild(table(["Data", "Evento", "PnL%"], data.trades.trades.slice(-10).map((t) => [fmtDate(t.time), t.event, fmtPct(t.pnlPct)])));
    } else {
      body.appendChild(el("div", { class: "card-sub" }, data.trades.reason));
    }

    body.appendChild(sectionTitle("History"));
    body.appendChild(el("div", { class: "card-sub" }, data.history.reason));
  }

  select.addEventListener("change", () => load(select.value));
  if (symbols.symbols.length > 0) await load(symbols.symbols[0]);
}

// ---- Features (grade símbolo x feature) ----

async function renderFeatures(container) {
  const { data, dataAge } = await fetchJson(`${API_BASE}/features`);
  container.appendChild(dataAgeLine(dataAge));
  for (const entry of data) {
    container.appendChild(sectionTitle(entry.symbol));
    container.appendChild(
      table(
        ["Feature", "Estado", "Ativa", "Strength", "Confidence", "Direção"],
        entry.features.map((f) => [f.feature, f.interpretation.state, f.active ? "ON" : "off", f.strength, `${f.confidence ?? "—"}%`, f.interpretation.direction])
      )
    );
  }
}

// ---- Collectors ----

async function renderCollectors(container) {
  const { data, dataAge } = await fetchJson(`${API_BASE}/collectors`);
  container.appendChild(dataAgeLine(dataAge));

  const healthy = data.rows.filter((r) => r.freshnessState === "fresh" && (r.consecutiveFailures ?? 0) === 0).length;
  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Universe", data.universe.length),
      card("Healthy", healthy, { cls: "positive" }),
      card("Não saudável", data.universe.length - healthy, { cls: data.universe.length - healthy > 0 ? "negative" : "" }),
    ])
  );

  container.appendChild(sectionTitle("Universe / Coverage"));
  container.appendChild(
    table(
      ["Símbolo", "Coverage", "Freshness", "Falhas seguidas", "Sanity", "Última coleta"],
      data.rows.map((r) => [r.symbol, r.coveragePct != null ? `${r.coveragePct}%` : "—", r.freshnessState, r.consecutiveFailures ?? "—", r.sanityPassRate != null ? `${r.sanityPassRate}%` : "—", fmtDate(r.lastSuccessAt)])
    )
  );

  container.appendChild(sectionTitle("Scheduler"));
  if (data.schedulerStats) {
    container.appendChild(table(["Domínio", "Em voo", "Na fila"], Object.entries(data.schedulerStats).map(([domain, s]) => [domain, s.activeCount, s.queuedCount])));
  } else {
    container.appendChild(el("div", { class: "card-sub" }, "coletor não está rodando ou heartbeat ainda não escreveu"));
  }

  container.appendChild(sectionTitle("Rate Limit"));
  if (data.rateLimitStats) {
    const r = data.rateLimitStats;
    container.appendChild(el("div", { class: "card-sub" }, `429: ${r.total429} | Retries: ${r.totalRetries} | Backoff acumulado: ${r.totalBackoffMs}ms`));
  } else {
    container.appendChild(el("div", { class: "card-sub" }, "sem dados ainda"));
  }
}

// ---- Replay ----

async function renderReplay(container) {
  const { data, dataAge } = await fetchJson(`${API_BASE}/replay`);
  if (!data.available) {
    container.appendChild(el("div", { class: "card-sub" }, data.reason));
    return;
  }
  container.appendChild(dataAgeLine(dataAge));
  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Snapshots", `${data.snapshotCount} / ${data.snapshotTarget}`, { sub: `${data.snapshotProgressPct}%` }),
      card("Experiments", data.experimentsCount),
      card("Decision Brain", data.decisionBrainReadiness?.ready ? "READY" : "não pronto"),
    ])
  );
  container.appendChild(bar(data.snapshotProgressPct));

  if (data.decisionBrainReadiness?.checks) {
    container.appendChild(sectionTitle("Critérios de prontidão do Decision Brain"));
    container.appendChild(
      table(
        ["Critério", "Passou?"],
        Object.entries(data.decisionBrainReadiness.checks).map(([name, c]) => [name, c.pass ? "sim" : "não"])
      )
    );
  }

  if (data.brainAccuracy) {
    container.appendChild(sectionTitle("Accuracy por Brain"));
    container.appendChild(table(["Brain", "Accuracy", "Snapshots"], Object.entries(data.brainAccuracy).map(([brain, a]) => [brain, `${a.accuracy}%`, a.snapshots ?? a.totalCalls ?? "—"])));
  }
}

// ---- Research / Evolution ----

async function renderResearch(container) {
  const { data } = await fetchJson(`${API_BASE}/evolution`);

  container.appendChild(
    el("div", { class: "card-grid" }, [
      card("Research Objects", data.totalResearchObjects),
      card("Production", data.byStatus.production),
      card("Replay", data.byStatus.replay),
      card("Research", data.byStatus.research),
      card("Idea", data.byStatus.idea),
      card("Brains", data.brainsCount),
      card("Features", data.featuresCount),
      card("Experiments", data.experimentsCount),
    ])
  );

  container.appendChild(sectionTitle("Por Status"));
  container.appendChild(bar((data.byStatus.production / data.totalResearchObjects) * 100));
  container.appendChild(el("div", { class: "card-sub" }, `${data.byStatus.production} de ${data.totalResearchObjects} Research Objects em Production`));

  container.appendChild(sectionTitle("Por Proof"));
  container.appendChild(table(["Proof", "Quantidade"], Object.entries(data.byProof).map(([k, v]) => [k, v])));

  container.appendChild(sectionTitle("Por Criticality"));
  container.appendChild(table(["Criticality", "Quantidade"], Object.entries(data.byCriticality).map(([k, v]) => [k, v])));
}

// ---- Navegação / boot ----

function buildNav(activeId, onSelect) {
  const nav = document.getElementById("app-nav");
  nav.innerHTML = "";
  const groups = [...new Set(SECTIONS.map((s) => s.group))];
  for (const group of groups) {
    nav.appendChild(el("div", { class: "nav-group-label" }, group));
    for (const section of SECTIONS.filter((s) => s.group === group)) {
      const item = el("div", { class: `nav-item ${section.id === activeId ? "active" : ""}` }, section.label);
      item.addEventListener("click", () => onSelect(section.id));
      nav.appendChild(item);
    }
  }
}

// `activeSectionCleanup` -- devolvido opcionalmente por section.render()
// (só demo-panel.js usa isto hoje, pro polling automático do painel Demo;
// as outras 7 seções não retornam nada, `typeof cleanup === "function"`
// fica false pra elas, ZERO mudança de comportamento). Chamado SEMPRE antes
// de montar a próxima seção -- limpeza determinística de timer/fetch em
// voo, nunca dependente só de uma checagem de DOM no próximo tick.
let activeSectionCleanup = null;

async function showSection(id) {
  const main = document.getElementById("app-main");
  if (activeSectionCleanup) {
    try {
      activeSectionCleanup();
    } catch {
      // limpeza nunca deveria lançar, mas nunca impede a troca de seção
    }
    activeSectionCleanup = null;
  }
  main.innerHTML = "";
  main.appendChild(el("div", { class: "section-loading" }, "carregando..."));
  buildNav(id, showSection);

  const section = SECTIONS.find((s) => s.id === id);
  try {
    main.innerHTML = "";
    const cleanup = await section.render(main);
    if (typeof cleanup === "function") activeSectionCleanup = cleanup;
  } catch (err) {
    main.innerHTML = "";
    main.appendChild(el("div", { class: "section-error" }, `Erro ao carregar ${section.label}: ${err.message}`));
  }
}

buildNav("overview", showSection);
showSection("overview");
refreshHeader();
setInterval(refreshHeader, HEADER_POLL_MS);

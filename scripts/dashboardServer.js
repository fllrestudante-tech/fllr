// Dashboard Operacional Web -- servidor HTTP nativo (sem Express), só
// leitura. Nunca escreve em nada, nunca chama a Bybit -- só orquestra os
// readers de lib/webDashboard/*, que por sua vez só chamam módulos já
// existentes (tradingHealth/featureBuilder/registry/etc.). Uso: npm run
// dashboard (porta configurável via config.dashboard.port).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const config = require("../config");
const { readHeader } = require("../lib/webDashboard/headerReader");
const { readOverview } = require("../lib/webDashboard/overviewReader");
const { readTrading } = require("../lib/webDashboard/tradingReader");
const { readAssetsList, readAsset } = require("../lib/webDashboard/assetReader");
const { readFeatures } = require("../lib/webDashboard/featureReader");
const { readCollectors } = require("../lib/webDashboard/collectorReader");
const { readReplay } = require("../lib/webDashboard/replayReader");
const { readEvolution } = require("../lib/webDashboard/researchReader");
const { readDemo } = require("../lib/webDashboard/demoReader");
const checks = require("../lib/healthChecks");
const { readReplayStats } = require("../lib/webDashboard/replayReader");
const { computeDashboardHealth } = require("../lib/webDashboard/dashboardHealth");
const { resolveDashboardPort, DASHBOARD_BIND_HOST } = require("../lib/webDashboard/dashboardBindConfig");
const { DEFAULT_DB_PATH } = require("../lib/infra/db");

const PUBLIC_DIR = path.join(__dirname, "..", "public", "dashboard");
const MIME_TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function ageMs(isoOrMs, now = Date.now()) {
  if (!isoOrMs) return null;
  const t = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  return Number.isNaN(t) ? null : now - t;
}

function envelope(data, { source = [], dataAge = null } = {}) {
  return { success: true, generatedAt: new Date().toISOString(), dataAge, source, data };
}

function errorEnvelope(message) {
  return { success: false, generatedAt: new Date().toISOString(), dataAge: null, source: [], error: message };
}

function sendJson(res, statusCode, body) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function lastCollectorHeartbeatAt() {
  try {
    const raw = fs.readFileSync(checks.DEFAULT_COLLECTOR_HEALTH_FILE, "utf8");
    return JSON.parse(raw).lastHeartbeatAt ?? null;
  } catch {
    return null;
  }
}

/**
 * Cada rota: { method, pattern (regex com grupos nomeados == params), handler(params, query) }.
 * `handler` pode lançar -- o dispatcher abaixo captura e devolve 500 com
 * erro honesto, nunca derruba o processo (uma seção com problema não deveria
 * tirar as outras do ar). `handler` pode devolver o corpo direto (sempre
 * HTTP 200, comportamento de sempre) ou `{ statusCode, body }` quando a
 * rota precisa de um status diferente (só /api/v1/health hoje).
 */
function buildRoutes({ dbPath = DEFAULT_DB_PATH } = {}) {
  return [
    {
      method: "GET",
      pattern: /^\/api\/v1\/health$/,
      // Somente leitura, local, leve, determinístico -- ver
      // lib/webDashboard/dashboardHealth.js. Nunca 200 se o perfil não for
      // "safe", o gate financeiro estiver ligado, ou o banco não estiver
      // pronto -- fail-closed de propósito (um futuro wrapper de autostart
      // NUNCA deveria abrir o navegador numa configuração perigosa).
      handler: () => {
        const { httpStatus, body } = computeDashboardHealth({ dbPath });
        return { statusCode: httpStatus, body };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/header$/,
      handler: () => envelope(readHeader(), { source: ["runtime/metrics/processes.json", "heartbeat do coletor", "connectivity/status.json", "market.db", "data/state.json", "registry"], dataAge: ageMs(lastCollectorHeartbeatAt()) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/overview$/,
      handler: () => envelope(readOverview(), { source: ["trades.jsonl", "data/state.json", "data/replay/stats.json", "market.db"], dataAge: ageMs(readReplayStats()?.generatedAt) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/trading$/,
      handler: (params, query) => envelope(readTrading({ window: query.get("window") || "all" }), { source: ["trades.jsonl"] }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/assets$/,
      handler: () => envelope({ symbols: readAssetsList() }, { source: ["MARKET_SYMBOLS (.env) ou config.symbol"] }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/assets\/([A-Za-z0-9]+)$/,
      handler: (params) => {
        const data = readAsset(params[0]);
        return envelope(data, { source: ["market.db:asset", "market.db:asset_statistics_window", "market.db:candles", "trades.jsonl", "data/replay/stats.json"], dataAge: ageMs(data.identity?.updatedAt) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/features$/,
      handler: () => envelope(readFeatures(), { source: ["market.db:asset_statistics_window", "market.db:asset_metric_statistics"] }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/collectors$/,
      handler: () => envelope(readCollectors(), { source: ["market.db:candles", "heartbeat do coletor"], dataAge: ageMs(lastCollectorHeartbeatAt()) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/replay$/,
      handler: () => {
        const data = readReplay();
        return envelope(data, { source: ["data/replay/stats.json", "registry"], dataAge: ageMs(data.generatedAt) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/evolution$/,
      handler: () => envelope(readEvolution(), { source: ["registry/research-objects.json"] }),
    },
    {
      method: "GET",
      pattern: /^\/api\/v1\/demo$/,
      // Painel do perfil demo -- 100% leitura local (state.json, kill-switch.json,
      // connectivity/status.json, runtime/processes/state.json), nunca chama a
      // Bybit/Telegram/AgentRouter (ver lib/webDashboard/demoReader.js).
      handler: () => envelope(readDemo(), { source: ["data/state.json", "runtime/demo/kill-switch.json", "runtime/connectivity/status.json", "runtime/processes/state.json"] }),
    },
  ];
}

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}

function handleApi(routes, req, res, pathname, query) {
  const matched = matchRoute(routes, req.method, pathname);
  if (!matched) return sendJson(res, 404, errorEnvelope(`rota não encontrada: ${req.method} ${pathname}`));

  try {
    const result = matched.route.handler(matched.params, query);
    // Compatibilidade: handler pode devolver o corpo direto (sempre 200,
    // como sempre foi) ou `{ statusCode, body }` quando precisa de outro
    // status (só /api/v1/health hoje) -- nenhuma rota existente muda de
    // comportamento, `envelope()`/`errorEnvelope()` nunca têm `.statusCode`.
    if (result && typeof result === "object" && typeof result.statusCode === "number" && "body" in result) {
      sendJson(res, result.statusCode, result.body);
    } else {
      sendJson(res, 200, result);
    }
  } catch (err) {
    console.error(`⚠️  Dashboard (${pathname}) falhou:`, err.message);
    sendJson(res, 500, errorEnvelope(err.message));
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, relative);

  // Nunca serve nada fora de public/dashboard/ (path traversal via ../).
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

/**
 * Fábrica -- permite testes construírem um servidor apontado pra um
 * `dbPath` fixture (nunca o market.db persistente real) sem tocar no
 * singleton usado por `npm run dashboard`. `dbPath` só afeta a rota de
 * health; as demais rotas continuam lendo dos módulos de
 * lib/webDashboard/* como sempre (inalterado nesta rodada).
 */
function createDashboardServer({ dbPath = DEFAULT_DB_PATH } = {}) {
  const routes = buildRoutes({ dbPath });
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${config.dashboard.port}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(routes, req, res, url.pathname, url.searchParams);
    } else {
      serveStatic(req, res, url.pathname);
    }
  });
}

const server = createDashboardServer();

if (require.main === module) {
  // Porta validada estritamente (lib/webDashboard/dashboardBindConfig.js) --
  // ausente/vazio usa o default documentado; qualquer valor inválido lança
  // e mata o processo ANTES de tentar abrir a porta, nunca escolhe outra
  // silenciosamente.
  const port = resolveDashboardPort();

  // Bind EXCLUSIVO em loopback -- nunca 0.0.0.0/::/hostname automático.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`📊 Dashboard: porta ${port} já está em uso -- encerrando (nunca escolhe outra porta silenciosamente).`);
    } else {
      console.error("📊 Dashboard: erro no servidor:", err.message);
    }
    process.exit(1);
  });

  server.listen(port, DASHBOARD_BIND_HOST, () => {
    console.log(`📊 Dashboard Operacional em http://${DASHBOARD_BIND_HOST}:${port} (só leitura, nunca chama a Bybit)`);
  });
}

module.exports = { server, createDashboardServer };

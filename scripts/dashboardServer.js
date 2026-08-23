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
const checks = require("../lib/healthChecks");
const { readReplayStats } = require("../lib/webDashboard/replayReader");

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
 * tirar as outras do ar).
 */
const routes = [
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
];

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}

function handleApi(req, res, pathname, query) {
  const matched = matchRoute(req.method, pathname);
  if (!matched) return sendJson(res, 404, errorEnvelope(`rota não encontrada: ${req.method} ${pathname}`));

  try {
    const body = matched.route.handler(matched.params, query);
    sendJson(res, 200, body);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${config.dashboard.port}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname, url.searchParams);
  } else {
    serveStatic(req, res, url.pathname);
  }
});

if (require.main === module) {
  server.listen(config.dashboard.port, () => {
    console.log(`📊 Dashboard Operacional em http://localhost:${config.dashboard.port} (só leitura, nunca chama a Bybit)`);
  });
}

module.exports = { server };

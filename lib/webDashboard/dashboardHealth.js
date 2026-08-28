// Health check local do dashboard -- separa DUAS coisas propositalmente:
//   (1) "processo HTTP vivo": trivial -- se esta rota respondeu (mesmo com
//       503), o processo está de pé. Não precisa de campo próprio.
//   (2) "prontidão pro perfil seguro": é isso que este módulo calcula --
//       exatamente o que um futuro wrapper de autostart precisa saber
//       ANTES de decidir abrir o navegador com segurança.
// Somente leitura, local, leve, determinístico. Nunca chama Bybit,
// Telegram, AgentRouter ou IA. Nunca escreve no banco, nunca tenta
// reparo/migração. Nunca revela caminho absoluto, stack ou detalhe interno
// na resposta pública -- só os campos enumerados abaixo.
const fs = require("fs");
const Database = require("better-sqlite3");
const { resolveSupervisorProfile } = require("../supervisorProfile");
const { isTradingExecutionEnabled } = require("../tradingExecutionGate");
const { DEFAULT_DB_PATH } = require("../infra/db");

const SERVICE_NAME = "crypto10-dashboard";

// Estrutura mínima que os readers de lib/webDashboard/* já dependem (ver
// fontes citadas nas rotas de scripts/dashboardServer.js) -- só a presença
// das tabelas, nunca conteúdo, nunca migração se ausente.
const REQUIRED_TABLES = ["asset", "candles"];

/**
 * Nunca propaga o valor bruto de SUPERVISOR_PROFILE pra fora -- se
 * `resolveSupervisorProfile` lançar (perfil não reconhecido), o rótulo
 * público é só "invalid", nunca o texto recebido.
 */
function safeResolveMode(env) {
  try {
    return resolveSupervisorProfile(env);
  } catch {
    return "invalid";
  }
}

/**
 * Conexão read-only própria (nunca compete por lock com os coletores em
 * WAL, mesmo padrão de lib/databaseHealth.js), fechada sempre no `finally`.
 * `fileMustExist: true` já falha rápido se o arquivo não existir -- nunca
 * cria/migra nada. Qualquer exceção (arquivo corrompido, não é um SQLite
 * válido, etc.) vira `false`, nunca propaga a mensagem de erro (que o
 * better-sqlite3 costuma preencher com o caminho do arquivo).
 */
function checkDatabaseReadiness(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`).all(...REQUIRED_TABLES);
    return rows.length === REQUIRED_TABLES.length;
  } catch {
    return false;
  } finally {
    if (db) db.close();
  }
}

/**
 * Devolve { ready, httpStatus, body }. `ready` (e portanto httpStatus 200)
 * exige TODAS as condições: perfil resolvido como "safe" + gate financeiro
 * desligado + banco acessível com a estrutura mínima. Qualquer uma falhando
 * -> httpStatus 503, nunca 200 -- fail-closed de propósito, pra nunca deixar
 * um wrapper de autostart abrir o navegador numa configuração perigosa
 * (execução financeira habilitada) ou incompleta (banco ausente/corrompido).
 */
function computeDashboardHealth({ env = process.env, dbPath = DEFAULT_DB_PATH } = {}) {
  const mode = safeResolveMode(env);
  const tradingExecutionEnabled = isTradingExecutionEnabled(env);
  const database = checkDatabaseReadiness(dbPath) ? "ok" : "unavailable";
  const ready = mode === "safe" && tradingExecutionEnabled === false && database === "ok";

  return {
    ready,
    httpStatus: ready ? 200 : 503,
    body: {
      status: ready ? "ok" : "degraded",
      service: SERVICE_NAME,
      mode,
      tradingExecutionEnabled,
      database,
    },
  };
}

module.exports = { SERVICE_NAME, REQUIRED_TABLES, computeDashboardHealth };

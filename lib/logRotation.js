// Log rotacionado por dia -- um arquivo por componente por dia
// (logs/YYYY-MM-DD/<componente>.log), trocando de arquivo sozinho quando a
// data muda (checado a cada write, sem cron/timer próprio). stdout e stderr
// do mesmo processo caem no mesmo arquivo -- é a informação mais simples que
// resolve o problema real (stdio:"inherit" perdia tudo quando o terminal
// fechava), não precisa de arquivos .out/.err separados.
const fs = require("fs");
const path = require("path");

const DEFAULT_LOGS_DIR = path.join(__dirname, "..", "logs");

// Convencao de log deste projeto (rodada de hardening AgentRouter/
// Telegram/Logging): TODO timestamp/nome de pasta-arquivo derivado de data,
// em qualquer componente Node ou PowerShell tocado por autostart, e
// ISO-8601 em UTC EXPLICITO (sufixo "Z"), nunca hora local/local+offset.
// toISOString() ja e UTC por definicao -- esta pasta-por-dia e a raiz da
// convencao; os wrappers PowerShell de scripts/autostart/*.ps1 (que
// escrevem NA MESMA arvore logs/<data>/) foram alinhados pra usar
// (Get-Date).ToUniversalTime() em vez de Get-Date local, eliminando a
// mistura silenciosa de fuso que antes fazia leituras como
// Get-Crypto10DashboardPortFromLog procurarem a pasta ERRADA perto da
// meia-noite (data local != data UTC por algumas horas todo dia em
// fusos não-UTC). Logs antigos gravados sob nome de pasta com data LOCAL
// (de antes desta rodada) continuam legiveis normalmente -- nenhum
// consumidor deste projeto faz parsing do FORMATO do timestamp em si, só
// casa por conteúdo de mensagem, então a mudança de convenção é
// estritamente prospectiva (não corrompe nem exige migrar nada já gravado).
function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function createRotatingWriter(componentName, { logsDir = DEFAULT_LOGS_DIR, now = () => new Date() } = {}) {
  let currentKey = null;
  let stream = null;

  function ensureStream() {
    const key = dateKey(now());
    if (key !== currentKey) {
      if (stream) stream.end();
      const dir = path.join(logsDir, key);
      fs.mkdirSync(dir, { recursive: true });
      stream = fs.createWriteStream(path.join(dir, `${componentName}.log`), { flags: "a" });
      currentKey = key;
    }
    return stream;
  }

  return {
    write(chunk) {
      ensureStream().write(chunk);
    },
    close() {
      if (stream) stream.end();
    },
    get currentPath() {
      return currentKey ? path.join(logsDir, currentKey, `${componentName}.log`) : null;
    },
  };
}

module.exports = { createRotatingWriter, dateKey, DEFAULT_LOGS_DIR };

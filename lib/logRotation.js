// Log rotacionado por dia -- um arquivo por componente por dia
// (logs/YYYY-MM-DD/<componente>.log), trocando de arquivo sozinho quando a
// data muda (checado a cada write, sem cron/timer próprio). stdout e stderr
// do mesmo processo caem no mesmo arquivo -- é a informação mais simples que
// resolve o problema real (stdio:"inherit" perdia tudo quando o terminal
// fechava), não precisa de arquivos .out/.err separados.
const fs = require("fs");
const path = require("path");

const DEFAULT_LOGS_DIR = path.join(__dirname, "..", "logs");

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

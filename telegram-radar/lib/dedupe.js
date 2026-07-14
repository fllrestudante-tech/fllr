const crypto = require("crypto");

// Normaliza pra detectar o mesmo "call" repostado em canais diferentes com
// pequenas variações de formatação (maiúsculas, pontuação, espaços, acentos).
function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos (marcas diacríticas combinantes)
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(text) {
  return crypto.createHash("sha1").update(normalizeText(text)).digest("hex");
}

/**
 * recentHashes: [{hash, time}] (time em ms epoch) — normalmente vindo de
 * lib/db.js getRecentHashes(). Retorna true se o texto já apareceu dentro
 * da janela, em qualquer canal.
 */
function isDuplicate(text, recentHashes, windowMs, now = Date.now()) {
  const hash = hashText(text);
  return recentHashes.some((r) => r.hash === hash && now - r.time <= windowMs);
}

module.exports = { normalizeText, hashText, isDuplicate };

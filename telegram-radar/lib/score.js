const WINDOWS_MS = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };

/**
 * mentions: [{ticker, time}] (time em ms epoch). Score por ticker e janela,
 * com decaimento linear dentro da janela (menção agora = peso 1, menção na
 * borda da janela = peso ~0). Menções com ticker null/vazio são ignoradas
 * (não têm o que ranquear).
 */
function scoreByTicker(mentions, now = Date.now(), windows = WINDOWS_MS) {
  const scores = {};
  for (const m of mentions) {
    if (!m.ticker) continue;
    const age = now - m.time;
    if (age < 0) continue;
    for (const [label, windowMs] of Object.entries(windows)) {
      if (age > windowMs) continue;
      const decay = 1 - age / windowMs;
      if (!scores[m.ticker]) scores[m.ticker] = {};
      scores[m.ticker][label] = (scores[m.ticker][label] || 0) + decay;
    }
  }
  return scores;
}

module.exports = { scoreByTicker, WINDOWS_MS };

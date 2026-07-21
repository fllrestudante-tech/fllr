const { KNOWN_TICKERS } = require("./knownTickers");

// Par tipo UNIUSDT, BTCUSDT.P (perpétuo) -- prioridade máxima, é o formato
// mais inequívoco (ninguém escreve "UNIUSDT" querendo dizer outra coisa).
const PAIR_REGEX = /\b([A-Z]{2,10})(USDT|USDC|BUSD|USD)(\.P)?\b/;
// Cashtag tipo $BTC, #SOL.
const CASHTAG_REGEX = /[$#]([A-Z][A-Z0-9]{1,9})\b/;
// Ticker "nu" (sem prefixo) -- só aceito se estiver na lista curada, pra não
// confundir jargão (SV, TP, SL, 4H) com ticker de verdade.
const BARE_TOKEN_REGEX = /\b([A-Z]{2,10})\b/g;

// Retorna { ticker, pair } -- pair só é preenchido quando o formato XXXUSDT
// foi encontrado; ticker é o melhor palpite em qualquer um dos 3 formatos.
function extractTicker(text) {
  if (!text) return { ticker: null, pair: null };

  const pairMatch = text.match(PAIR_REGEX);
  if (pairMatch) {
    const suffix = pairMatch[3] ? pairMatch[3] : "";
    return { ticker: pairMatch[1], pair: `${pairMatch[1]}${pairMatch[2]}${suffix}` };
  }

  const cashtagMatch = text.match(CASHTAG_REGEX);
  if (cashtagMatch) {
    return { ticker: cashtagMatch[1], pair: null };
  }

  const bareMatches = [...text.matchAll(BARE_TOKEN_REGEX)].map((m) => m[1]);
  const known = bareMatches.find((token) => KNOWN_TICKERS.has(token));
  if (known) {
    return { ticker: known, pair: null };
  }

  return { ticker: null, pair: null };
}

module.exports = { extractTicker };

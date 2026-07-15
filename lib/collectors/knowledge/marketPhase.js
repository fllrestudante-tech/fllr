// market_phase é calculado sob demanda, NÃO gravado como coluna -- persistir
// isso exigiria um job de fundo constantemente reclassificando linhas só
// pra refletir a passagem do tempo, sem ganho nenhum (a mesma pergunta dá
// pra responder na hora, comparando event_time com o relógio atual).
const LIVE_WINDOW_MS = 15 * 60 * 1000; // margem em volta do horário exato do evento

function getMarketPhase(event, now = Date.now()) {
  const beforeStart = event.eventTime - (event.impactWindowBeforeMs || 0);
  const afterEnd = event.eventTime + (event.impactWindowAfterMs || 0);

  if (now < event.eventTime - LIVE_WINDOW_MS) {
    return now >= beforeStart ? "pre-event" : "outside-window";
  }
  if (now <= event.eventTime + LIVE_WINDOW_MS) {
    return "live-event";
  }
  return now <= afterEnd ? "post-event" : "outside-window";
}

module.exports = { getMarketPhase, LIVE_WINDOW_MS };

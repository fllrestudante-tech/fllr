// Provider do calendário do FOMC -- dado estático (ver fomcCalendarData.js),
// sem chamada de rede nenhuma. client é ignorado, mantido só pra bater com
// a interface comum dos outros providers (fetchRawEvents(client, opts)).
const { FOMC_MEETINGS_2026 } = require("./fomcCalendarData");

async function fetchRawEvents() {
  return FOMC_MEETINGS_2026;
}

// A decisão/coletiva de imprensa acontece no segundo dia da reunião, às 14h
// ET -- aproximado aqui pra 18h UTC (horário de verão dos EUA).
function normalize(rawEvent) {
  const eventTime = new Date(rawEvent.end + "T18:00:00Z").getTime();
  return {
    sourceEventId: `fomc-${rawEvent.start}`,
    title: "Reunião do FOMC",
    description: `Decisão de política monetária do Federal Reserve (${rawEvent.start} a ${rawEvent.end})`,
    category: "fomc",
    assets: [],
    eventTime,
    confirmed: true,
    sourceUrl: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  };
}

module.exports = { name: "fomc_calendar", fetchRawEvents, normalize };

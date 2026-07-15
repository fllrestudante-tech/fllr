// Provider da FRED -- calendário de divulgação de indicadores macro oficiais
// (CPI, payroll, GDP). Precisa de FRED_API_KEY no .env (grátis, instantânea
// em fredaccount.stlouisfed.org/apikeys).
const RELEASES = [
  { releaseId: 10, category: "cpi", title: "Consumer Price Index (CPI)" },
  { releaseId: 50, category: "payroll", title: "Employment Situation (Payroll)" },
  { releaseId: 53, category: "gdp", title: "Gross Domestic Product (GDP)" },
];

async function fetchRawEvents(client, opts = {}) {
  const results = [];
  for (const release of RELEASES) {
    const dates = await client.getReleaseDates(release.releaseId, { limit: opts.limit ?? 6 });
    for (const d of dates) {
      results.push({ ...d, category: release.category, title: release.title });
    }
  }
  return results;
}

// FRED só devolve a data (sem hora) -- divulgações do BLS/BEA saem
// tipicamente às 8h30 ET, aproximado aqui pra 12h30 UTC (horário de verão
// dos EUA). Aproximação aceitável dado que as janelas de impacto são de
// horas, não minutos.
function normalize(rawEvent) {
  const eventTime = new Date(rawEvent.date + "T12:30:00Z").getTime();
  return {
    sourceEventId: `${rawEvent.release_id}-${rawEvent.date}`,
    title: rawEvent.title,
    description: null,
    category: rawEvent.category,
    assets: [],
    eventTime,
    confirmed: true,
    sourceUrl: `https://fred.stlouisfed.org/release?rid=${rawEvent.release_id}`,
  };
}

module.exports = { name: "fred", fetchRawEvents, normalize };

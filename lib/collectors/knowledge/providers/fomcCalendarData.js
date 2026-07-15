// Datas publicadas anualmente pelo Federal Reserve
// (federalreserve.gov/monetarypolicy/fomccalendars.htm) -- sem API oficial,
// precisa de atualização manual quando o Fed publicar o calendário do
// próximo ano (normalmente em setembro/outubro do ano anterior).
const FOMC_MEETINGS_2026 = [
  { start: "2026-01-27", end: "2026-01-28" },
  { start: "2026-03-17", end: "2026-03-18" },
  { start: "2026-04-28", end: "2026-04-29" },
  { start: "2026-06-16", end: "2026-06-17" },
  { start: "2026-07-28", end: "2026-07-29" },
  { start: "2026-09-15", end: "2026-09-16" },
  { start: "2026-10-27", end: "2026-10-28" },
  { start: "2026-12-08", end: "2026-12-09" },
];

module.exports = { FOMC_MEETINGS_2026 };

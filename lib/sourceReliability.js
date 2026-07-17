// Source Reliability: uma ÚNICA representação de confiabilidade por fonte
// externa (Bybit/CoinGecko/CoinMarketCal/FRED/...), com duas dimensões:
//
//   Source
//     ├── operationalReliability   <- implementado agora (este arquivo)
//     └── predictiveReliability    <- reservado, fase futura (Validation/
//                                     Replay/YouTube/X/Narrative Engine)
//
// Em vez de "API Health" e "Source Reliability" como dois conceitos
// parcialmente sobrepostos, este módulo é a evolução do API Health
// (lib/apiHealth.js) -- reusa a agregação por provider de lá, não duplica a
// lógica, só combina com freshness e Data Confidence Score pra virar um
// score operacional único por fonte.
const { getSla } = require("./slaRegistry");

/**
 * Agrupa um mapa domain->score por provider (via SLA Registry), usando o
 * MÍNIMO entre os domínios do mesmo provider -- mesma escolha conservadora
 * já usada em lib/apiHealth.js::aggregateProviderHealth (um domínio ruim não
 * deveria se esconder atrás da média dos outros).
 */
function aggregateByProvider(scoresByDomain) {
  const byProvider = {};
  for (const [domain, score] of Object.entries(scoresByDomain)) {
    if (typeof score !== "number") continue;
    const provider = getSla(domain).provider || domain;
    (byProvider[provider] = byProvider[provider] || []).push(score);
  }
  const result = {};
  for (const [provider, scores] of Object.entries(byProvider)) {
    result[provider] = Math.min(...scores);
  }
  return result;
}

function computeOperationalReliability({ apiHealthScore = null, freshnessScore = null, dataConfidenceScore = null } = {}) {
  const breakdown = { apiHealthScore, freshnessScore, dataConfidenceScore };
  const parts = Object.values(breakdown).filter((v) => typeof v === "number");
  if (parts.length === 0) return { score: null, breakdown };
  // sem arredondar -- o exemplo do usuário ("Bybit REST -> 99,8") preserva
  // casa decimal, arredondar pra inteiro perderia precisão sem necessidade.
  const avg = parts.reduce((sum, v) => sum + v, 0) / parts.length;
  return { score: Math.round(avg * 10) / 10, breakdown };
}

function computeSourceReliability(provider, inputs) {
  return {
    provider,
    operationalReliability: computeOperationalReliability(inputs),
    predictiveReliability: null,
  };
}

/**
 * Constrói o registro completo a partir dos 3 mapas domain->score já
 * calculados em outro lugar (apiHealth, freshness, dataConfidence) -- este
 * módulo não recalcula nada, só agrega e combina.
 */
function buildSourceReliabilityRegistry({ apiHealthByDomain = {}, freshnessByDomain = {}, dataConfidenceByDomain = {} }) {
  const apiHealthByProvider = aggregateByProvider(
    Object.fromEntries(Object.entries(apiHealthByDomain).map(([d, h]) => [d, h?.score ?? null]))
  );
  const freshnessByProvider = aggregateByProvider(
    Object.fromEntries(Object.entries(freshnessByDomain).map(([d, f]) => [d, f?.score ?? null]))
  );
  const confidenceByProvider = aggregateByProvider(
    Object.fromEntries(Object.entries(dataConfidenceByDomain).map(([d, c]) => [d, c?.score ?? null]))
  );

  const providers = new Set([...Object.keys(apiHealthByProvider), ...Object.keys(freshnessByProvider), ...Object.keys(confidenceByProvider)]);
  const registry = {};
  for (const provider of providers) {
    registry[provider] = computeSourceReliability(provider, {
      apiHealthScore: apiHealthByProvider[provider] ?? null,
      freshnessScore: freshnessByProvider[provider] ?? null,
      dataConfidenceScore: confidenceByProvider[provider] ?? null,
    });
  }
  return registry;
}

module.exports = { aggregateByProvider, computeOperationalReliability, computeSourceReliability, buildSourceReliabilityRegistry };

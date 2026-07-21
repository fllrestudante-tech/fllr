// Estrutura técnica mencionada -- retorna um dicionário de flags booleanas
// (múltiplos padrões podem coexistir na mesma mensagem, ex: suporte +
// resistência + cunha ascendente na mesma "Atualização"). Deliberadamente
// SEM "channel" (canal de alta/baixa) -- colidiria demais com "canal" no
// sentido de canal do Telegram, o próprio domínio que estamos processando.
const PATTERNS = {
  support: /\bsuporte\b/i,
  resistance: /\bresist[êe]ncia\b/i,
  ascendingWedge: /cunha ascendente/i,
  descendingWedge: /cunha descendente/i,
  triangle: /\btri[âa]ngulo\b/i,
  doubleTop: /topo duplo/i,
  doubleBottom: /fundo duplo/i,
  breakout: /rompiment|rompendo a resist|romper a resist|breakout/i,
  breakdown: /rompendo o suporte|romper o suporte|rompimento do suporte|breakdown/i,
  consolidation: /consolida|lateraliza/i,
  higherHighsLows: /topos?\s+e\s+fundos?\s+ascendente/i,
  lowerHighsLows: /topos?\s+e\s+fundos?\s+descendente/i,
  correction: /correç[ãa]o|correcao/i,
  volumeMentioned: /\bvolume\b/i,
};

function extractStructure(text) {
  const features = {};
  const lower = text || "";
  for (const [name, regex] of Object.entries(PATTERNS)) {
    features[name] = regex.test(lower);
  }
  return features;
}

module.exports = { extractStructure, STRUCTURE_KEYS: Object.keys(PATTERNS) };

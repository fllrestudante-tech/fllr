// Padrão técnico "principal" da mensagem (Breakout/Wedge/Range/etc) --
// derivado das flags de extractStructure.js, não do texto direto. Ordem de
// prioridade: padrões mais específicos (cunha, topo/fundo duplo) antes de
// genéricos (suporte+resistência juntos = "Range").
function extractSignalType(structureFeatures) {
  if (!structureFeatures) return null;
  const f = structureFeatures;
  if (f.ascendingWedge) return "Ascending Wedge";
  if (f.descendingWedge) return "Descending Wedge";
  if (f.doubleTop) return "Double Top";
  if (f.doubleBottom) return "Double Bottom";
  if (f.triangle) return "Triangle";
  if (f.breakout) return "Breakout";
  if (f.breakdown) return "Breakdown";
  if (f.consolidation) return "Consolidation";
  if (f.higherHighsLows) return "Uptrend Structure";
  if (f.lowerHighsLows) return "Downtrend Structure";
  if (f.support && f.resistance) return "Range";
  return null;
}

module.exports = { extractSignalType };

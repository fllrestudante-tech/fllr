// Primitivas de estatística pura -- zero I/O, zero dependência de `db`,
// mesma separação que lib/indicators.js já usa (matemática pura) vs.
// lib/brains/*BrainData.js (I/O). Usadas por
// lib/knowledgeBase/statisticsComputer.js pra montar Asset Statistics.
// Convenção: desvio padrão é POPULACIONAL (divide por n, não n-1) --
// descrevemos a amostra histórica inteira que temos, não estimamos um
// parâmetro de uma população maior. Toda função devolve `null` (nunca
// lança erro nem devolve NaN) quando não há dado suficiente pro cálculo
// fazer sentido -- mesma disciplina de "não fabricar certeza que os
// dados não sustentam" já usada em lib/dataConfidenceScore.js.
function mean(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sortAsc(values) {
  return [...values].sort((a, b) => a - b);
}

function median(values) {
  return percentile(sortAsc(values), 50);
}

function stddev(values) {
  if (!values || values.length === 0) return null;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * `sorted` já deve estar ordenado ascendente (quem chama controla,
 * evita reordenar a cada chamada quando várias percentis são pedidas da
 * mesma amostra). Interpolação linear (mesmo método default do numpy).
 */
function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function mad(values) {
  if (!values || values.length === 0) return null;
  const m = median(values);
  const deviations = values.map((v) => Math.abs(v - m));
  return median(deviations);
}

function iqr(values) {
  if (!values || values.length === 0) return null;
  const sorted = sortAsc(values);
  return percentile(sorted, 75) - percentile(sorted, 25);
}

/** Remove trimPct/2 de cada ponta (arredondado pra baixo) antes de tirar a média. */
function trimmedMean(values, trimPct = 0.1) {
  if (!values || values.length === 0) return null;
  const sorted = sortAsc(values);
  const cut = Math.floor((sorted.length * trimPct) / 2);
  const trimmed = sorted.slice(cut, sorted.length - cut);
  return trimmed.length > 0 ? mean(trimmed) : mean(sorted);
}

/** Substitui os clampPct/2 mais extremos de cada ponta pelo valor de corte, em vez de descartar. */
function winsorizedMean(values, clampPct = 0.1) {
  if (!values || values.length === 0) return null;
  const sorted = sortAsc(values);
  const cut = Math.floor((sorted.length * clampPct) / 2);
  if (cut === 0) return mean(sorted);
  const lowerBound = sorted[cut];
  const upperBound = sorted[sorted.length - 1 - cut];
  const clamped = sorted.map((v) => Math.min(Math.max(v, lowerBound), upperBound));
  return mean(clamped);
}

/** 3º momento padronizado -- assimetria da distribuição (>0 cauda à direita, <0 à esquerda). */
function skewness(values) {
  if (!values || values.length < 3) return null;
  const m = mean(values);
  const sd = stddev(values);
  if (!sd) return null;
  const n = values.length;
  const thirdMoment = values.reduce((sum, v) => sum + (v - m) ** 3, 0) / n;
  return thirdMoment / sd ** 3;
}

/** 4º momento padronizado, excesso (kurtosis normal = 0) -- >0 caudas mais pesadas que a normal. */
function kurtosis(values) {
  if (!values || values.length < 4) return null;
  const m = mean(values);
  const sd = stddev(values);
  if (!sd) return null;
  const n = values.length;
  const fourthMoment = values.reduce((sum, v) => sum + (v - m) ** 4, 0) / n;
  return fourthMoment / sd ** 4 - 3;
}

module.exports = { mean, median, stddev, sortAsc, percentile, mad, iqr, trimmedMean, winsorizedMean, skewness, kurtosis };

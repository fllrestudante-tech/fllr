const test = require("node:test");
const assert = require("node:assert/strict");
const { formatQualityTable, formatCrossSourceSection, formatSourceReliabilitySection } = require("../lib/dashboard");

test("formatQualityTable: sem snapshot, mensagem honesta", () => {
  assert.ok(formatQualityTable(null)[0].includes("sampler ainda não rodou"));
});

test("formatQualityTable: uma linha por domínio com os 4 pilares", () => {
  const snapshot = {
    quality: {
      candles: { coverage: { coveragePct: 96.7 }, gaps: { gapsCount: 0 }, sanity: { passRate: 100 }, dataConfidence: { score: 99 } },
    },
  };
  const lines = formatQualityTable(snapshot);
  assert.equal(lines.length, 3); // header + separador + 1 linha
  assert.ok(lines[2].includes("candles"));
  assert.ok(lines[2].includes("99"));
});

test("formatCrossSourceSection: mostra N/A com o texto exato pedido pelo usuário -- nunca como erro", () => {
  const snapshot = {
    crossSourceValidation: {
      candles: { status: "N/A", reason: "Only one market data provider available." },
    },
  };
  const lines = formatCrossSourceSection(snapshot);
  assert.ok(lines[0].includes("N/A"));
  assert.ok(lines[0].includes("Only one market data provider available."));
  assert.ok(lines[0].includes("⬜")); // ícone neutro, não de erro/warning
});

test("formatCrossSourceSection: WARNING e ERROR usam ícones distintos de N/A", () => {
  const snapshot = {
    crossSourceValidation: {
      candles: { status: "WARNING", reason: "Um provider indisponível." },
      funding: { status: "ERROR", reason: "Divergência de 5% excede o limite." },
    },
  };
  const lines = formatCrossSourceSection(snapshot);
  assert.ok(lines[0].includes("⚠️"));
  assert.ok(lines[1].includes("🔴"));
});

test("formatSourceReliabilitySection: mostra Operational Reliability e Predictive Reliability reservado", () => {
  const snapshot = {
    sourceReliability: {
      bybit: { operationalReliability: { score: 78.3 }, predictiveReliability: null },
    },
  };
  const lines = formatSourceReliabilitySection(snapshot);
  assert.ok(lines[2].includes("78.3"));
  assert.ok(lines[2].includes("fase futura"));
});

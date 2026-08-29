const test = require("node:test");
const assert = require("node:assert/strict");
const {
  InvalidDecimalError,
  QuantityBelowMinimumError,
  QuantityAboveMaximumError,
  parseStrictDecimal,
  parseNonNegativeDecimalAllowZero,
  floorToStep,
  roundToStep,
  multiplyDecimalStrings,
  addDecimalStrings,
  compareDecimalStrings,
  validateInstrumentQty,
} = require("../lib/decimalSafety");

// =====================================================================
// parseStrictDecimal
// =====================================================================

test("parseStrictDecimal: aceita string decimal simples", () => {
  assert.equal(parseStrictDecimal("1.2345"), "1.2345");
  assert.equal(parseStrictDecimal("100"), "100");
});

test("parseStrictDecimal: aceita number finito simples", () => {
  assert.equal(parseStrictDecimal(1.5), "1.5");
});

test("parseStrictDecimal: rejeita notação científica", () => {
  assert.throws(() => parseStrictDecimal("1e10"), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal("1E-5"), InvalidDecimalError);
});

test("parseStrictDecimal: number que produziria notação científica ao virar string -> rejeitado, nunca aceito silenciosamente", () => {
  assert.throws(() => parseStrictDecimal(0.0000001), InvalidDecimalError);
});

test("parseStrictDecimal: rejeita NaN/Infinity", () => {
  assert.throws(() => parseStrictDecimal(NaN), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal(Infinity), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal(-Infinity), InvalidDecimalError);
});

test("parseStrictDecimal: rejeita negativo, zero, ausente, vazio, tipo errado", () => {
  assert.throws(() => parseStrictDecimal("-1"), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal("0"), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal(null), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal(undefined), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal(""), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal({}), InvalidDecimalError);
  assert.throws(() => parseStrictDecimal([1]), InvalidDecimalError);
});

test("parseStrictDecimal: rejeita string com vírgula, espaço interno, ou lixo", () => {
  for (const value of ["1,5", "1 5", "1.5.5", "abc", "1.5abc", "0x10"]) {
    assert.throws(() => parseStrictDecimal(value), InvalidDecimalError, `"${value}" deveria ser rejeitado`);
  }
});

// =====================================================================
// floorToStep -- NUNCA arredonda pra cima
// =====================================================================

test("floorToStep: arredonda pra baixo pro múltiplo do step", () => {
  assert.equal(floorToStep("1.2399", "0.001"), "1.239");
  assert.equal(floorToStep("1.2391", "0.001"), "1.239");
});

test("floorToStep: valor já exato no step -> permanece igual", () => {
  assert.equal(floorToStep("1.5", "0.1"), "1.5");
});

test("floorToStep: resultado NUNCA maior que o valor original (prova por amostragem)", () => {
  const cases = [
    ["1.999", "0.01"],
    ["0.0019", "0.001"],
    ["100.456789", "0.1"],
    ["5", "3"],
  ];
  for (const [value, step] of cases) {
    const floored = floorToStep(value, step);
    assert.ok(compareDecimalStrings(floored, value) <= 0, `floorToStep(${value}, ${step}) = ${floored} deveria ser <= ${value}`);
  }
});

test("floorToStep: step zero -> lança (nunca divide por zero silenciosamente)", () => {
  assert.throws(() => floorToStep("1.5", "0"), InvalidDecimalError);
});

// =====================================================================
// compareDecimalStrings
// =====================================================================

test("compareDecimalStrings: compara corretamente com casas decimais diferentes", () => {
  assert.equal(compareDecimalStrings("1.1", "1.10"), 0);
  assert.equal(compareDecimalStrings("1.2", "1.10"), 1);
  assert.equal(compareDecimalStrings("1.05", "1.1"), -1);
});

// =====================================================================
// validateInstrumentQty -- contrato completo (Bloqueador 5)
// =====================================================================

test("validateInstrumentQty: quantidade válida, dentro de min/max, arredondada pro qtyStep", () => {
  const result = validateInstrumentQty({ qty: "1.2399", qtyStep: "0.001", minOrderQty: "0.001", maxOrderQty: "100" });
  assert.equal(result, "1.239");
});

test("validateInstrumentQty: resultado abaixo do mínimo APÓS arredondar -> REJEITADO, NUNCA empurrado pra cima até o mínimo", () => {
  assert.throws(() => validateInstrumentQty({ qty: "0.0005", qtyStep: "0.001", minOrderQty: "0.001" }), QuantityBelowMinimumError);
});

test("validateInstrumentQty: resultado acima do máximo -> rejeitado", () => {
  assert.throws(() => validateInstrumentQty({ qty: "1000", qtyStep: "0.001", minOrderQty: "0.001", maxOrderQty: "100" }), QuantityAboveMaximumError);
});

test("validateInstrumentQty: qty negativa/zero/NaN/notação científica -> rejeitado, nunca normalizado", () => {
  for (const qty of ["-1", "0", NaN, "1e5"]) {
    assert.throws(() => validateInstrumentQty({ qty, qtyStep: "0.001", minOrderQty: "0.001" }), InvalidDecimalError, `qty=${qty} deveria ser rejeitado`);
  }
});

test("validateInstrumentQty: qtyStep inválido -> rejeitado", () => {
  assert.throws(() => validateInstrumentQty({ qty: "1", qtyStep: "abc", minOrderQty: "0.001" }), InvalidDecimalError);
});

test("validateInstrumentQty: sem maxOrderQty informado -> não aplica teto (comportamento opcional documentado)", () => {
  const result = validateInstrumentQty({ qty: "1000000", qtyStep: "1", minOrderQty: "1" });
  assert.equal(result, "1000000");
});

test("validateInstrumentQty: qualquer normalização NUNCA resulta em valor maior que o qty original pedido (prova central do Bloqueador 5)", () => {
  const cases = [
    { qty: "1.9999", qtyStep: "0.01", minOrderQty: "0.01" },
    { qty: "0.30001", qtyStep: "0.1", minOrderQty: "0.1" },
    { qty: "5.5", qtyStep: "1", minOrderQty: "1" },
  ];
  for (const c of cases) {
    const result = validateInstrumentQty(c);
    assert.ok(compareDecimalStrings(result, c.qty) <= 0, `resultado ${result} nunca deveria exceder o qty pedido ${c.qty}`);
  }
});

// =====================================================================
// parseNonNegativeDecimalAllowZero -- aceita "0" (acumuladores)
// =====================================================================

test("parseNonNegativeDecimalAllowZero: aceita zero (string ou number), rejeita negativo, aceita positivo normal", () => {
  assert.equal(parseNonNegativeDecimalAllowZero("0"), "0");
  assert.equal(parseNonNegativeDecimalAllowZero(0), "0");
  assert.equal(parseNonNegativeDecimalAllowZero("1.5"), "1.5");
  assert.throws(() => parseNonNegativeDecimalAllowZero("-1"), InvalidDecimalError);
});

// =====================================================================
// roundToStep -- arredonda pro múltiplo mais próximo (metade pra cima),
// usado SÓ pra preço/stop-loss, nunca pra quantidade.
// =====================================================================

test("roundToStep: arredonda pro tick mais próximo, metade pra cima", () => {
  assert.equal(roundToStep("1.234", "0.01"), "1.23");
  assert.equal(roundToStep("1.235", "0.01"), "1.24"); // metade exata -> pra cima
  assert.equal(roundToStep("1.236", "0.01"), "1.24");
});

test("roundToStep: step zero -> lança", () => {
  assert.throws(() => roundToStep("1.5", "0"), InvalidDecimalError);
});

// =====================================================================
// multiplyDecimalStrings -- notional = qty × price, sem ponto flutuante
// =====================================================================

test("multiplyDecimalStrings: multiplicação exata sem erro de ponto flutuante binário", () => {
  assert.equal(multiplyDecimalStrings("0.1", "0.2"), "0.02");
  assert.equal(multiplyDecimalStrings("2", "40"), "80");
  assert.equal(multiplyDecimalStrings("1.9", "20"), "38");
});

test("multiplyDecimalStrings: prova que 0.1 * 0.2 NÃO produz o erro clássico de float binário (0.020000000000000004)", () => {
  assert.equal(Number("0.1") * Number("0.2") === 0.02, false); // o problema que este módulo existe pra evitar
  assert.equal(multiplyDecimalStrings("0.1", "0.2"), "0.02");
});

// =====================================================================
// addDecimalStrings -- soma pra acumular exposição (posição + ordens
// abertas + nova ordem), aceita "0" nos dois lados
// =====================================================================

test("addDecimalStrings: soma exata, aceita zero de qualquer lado", () => {
  assert.equal(addDecimalStrings("0", "40"), "40");
  assert.equal(addDecimalStrings("40", "0"), "40");
  assert.equal(addDecimalStrings("0.1", "0.2"), "0.3");
  assert.equal(addDecimalStrings("45", "40"), "85");
});

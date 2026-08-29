// Aritmética decimal segura para quantidade/preço financeiro do perfil
// demo -- NUNCA usa `Number` para arredondar (ponto flutuante binário
// introduz erro silencioso, ex.: 0.1 + 0.2 !== 0.3). Trabalha inteiramente
// em strings/BigInt. Só arredonda PRA BAIXO (floor) -- nunca aumenta uma
// quantidade além do que foi pedido; qualquer normalização que exigiria
// aumentar (ex.: empurrar pra cima até bater minOrderQty) FALHA em vez de
// silenciosamente aumentar exposição.
class InvalidDecimalError extends Error {
  constructor(field, raw, detail) {
    super(`${field} inválido (${JSON.stringify(raw)}): ${detail}`);
    this.name = this.constructor.name;
    this.code = "INVALID_DECIMAL";
    this.field = field;
  }
}
class QuantityBelowMinimumError extends Error {
  constructor(flooredQty, minOrderQty) {
    super(`Quantidade após arredondar pra baixo (${flooredQty}) ficou abaixo do mínimo do instrumento (${minOrderQty}) -- rejeitado, NUNCA aumentado automaticamente pro mínimo.`);
    this.name = this.constructor.name;
    this.code = "QUANTITY_BELOW_MINIMUM";
    this.flooredQty = flooredQty;
    this.minOrderQty = minOrderQty;
  }
}
class QuantityAboveMaximumError extends Error {
  constructor(qty, maxOrderQty) {
    super(`Quantidade (${qty}) excede o máximo do instrumento (${maxOrderQty}).`);
    this.name = this.constructor.name;
    this.code = "QUANTITY_ABOVE_MAXIMUM";
  }
}

// Só dígitos decimais simples (sinal opcional, um ponto opcional) --
// rejeita notação científica ("1e10"), NaN/Infinity, espaços, vírgula.
const STRICT_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Valida e normaliza um valor decimal recebido como string OU number
 * finito simples -- nunca aceita string vazia, notação científica,
 * NaN/Infinity, nem número negativo (quantidade/preço financeiro nunca é
 * negativo neste contrato). Devolve a representação em STRING, nunca um
 * `Number` -- o chamador nunca deveria voltar a fazer aritmética
 * binária sobre o resultado.
 */
function parseStrictDecimal(raw, field = "value") {
  if (raw === null || raw === undefined) throw new InvalidDecimalError(field, raw, "ausente");
  let str;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new InvalidDecimalError(field, raw, "não-finito (NaN/Infinity)");
    // Number.prototype.toString() pode emitir notação científica pra
    // valores muito pequenos/grandes -- rejeitado abaixo pelo padrão
    // estrito, nunca aceito silenciosamente.
    str = raw.toString();
  } else if (typeof raw === "string") {
    str = raw.trim();
  } else {
    throw new InvalidDecimalError(field, raw, "tipo inesperado (esperado string ou number)");
  }
  if (!STRICT_DECIMAL_PATTERN.test(str)) throw new InvalidDecimalError(field, raw, "formato inválido (esperado decimal simples, sem notação científica)");
  if (str.startsWith("-")) throw new InvalidDecimalError(field, raw, "negativo não permitido");
  if (Number(str) === 0) throw new InvalidDecimalError(field, raw, "zero não permitido");
  return str;
}

function decimalsOf(stepStr) {
  const idx = stepStr.indexOf(".");
  return idx === -1 ? 0 : stepStr.length - idx - 1;
}

/**
 * Converte um decimal em string pra BigInt de "unidades inteiras" na
 * escala de `decimals` casas -- ex.: toScaledBigInt("1.2345", 4) ->
 * 12345n. Trunca (NUNCA arredonda) qualquer casa extra além de
 * `decimals` -- truncar é sempre <= o valor original, nunca aumenta.
 */
function toScaledBigInt(decimalStr, decimals) {
  const [intPart, fracPart = ""] = decimalStr.split(".");
  const fracTruncated = fracPart.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(intPart + fracTruncated);
}

function fromScaledBigInt(scaled, decimals) {
  const str = scaled.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return str;
  const intPart = str.slice(0, -decimals) || "0";
  const fracPart = str.slice(-decimals);
  return `${intPart}.${fracPart}`;
}

/** Remove zeros à direita depois do ponto (nunca muda o valor numérico -- só a representação). "1.2390" -> "1.239"; "1.000" -> "1". */
function trimTrailingZeros(decimalStr) {
  if (!decimalStr.includes(".")) return decimalStr;
  return decimalStr.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Arredonda `valueStr` PRA BAIXO pro múltiplo de `stepStr` mais próximo,
 * sem ponto flutuante. Ex.: floorToStep("1.2399", "0.001") -> "1.239".
 * Nunca devolve um valor MAIOR que o original.
 */
function floorToStep(valueStr, stepStr, field = "value") {
  const value = parseStrictDecimal(valueStr, field);
  const step = parseStrictDecimal(stepStr, `${field}Step`);
  const decimals = Math.max(decimalsOf(value), decimalsOf(step));
  const valueScaled = toScaledBigInt(value, decimals);
  const stepScaled = toScaledBigInt(step, decimals);
  if (stepScaled === 0n) throw new InvalidDecimalError(`${field}Step`, stepStr, "step não pode ser zero");
  const flooredScaled = (valueScaled / stepScaled) * stepScaled; // divisão inteira trunca -- sempre <= original
  return trimTrailingZeros(fromScaledBigInt(flooredScaled, decimals));
}

/**
 * Arredonda `valueStr` pro múltiplo de `stepStr` mais próximo (metade
 * pra cima), sem ponto flutuante. Usado só pra PREÇO/stop-loss (nunca
 * quantidade -- ver floorToStep) -- arredondar preço pro tick mais
 * próximo não tem o mesmo risco de "aumentar exposição silenciosamente"
 * que arredondar quantidade pra cima teria, já que exposição =
 * qty × price e é qty que fica sob teto explícito.
 */
function roundToStep(valueStr, stepStr, field = "value") {
  const value = parseStrictDecimal(valueStr, field);
  const step = parseStrictDecimal(stepStr, `${field}Step`);
  const decimals = Math.max(decimalsOf(value), decimalsOf(step));
  const valueScaled = toScaledBigInt(value, decimals);
  const stepScaled = toScaledBigInt(step, decimals);
  if (stepScaled === 0n) throw new InvalidDecimalError(`${field}Step`, stepStr, "step não pode ser zero");
  const remainder = valueScaled % stepScaled;
  const roundedScaled = remainder * 2n >= stepScaled ? valueScaled - remainder + stepScaled : valueScaled - remainder;
  return trimTrailingZeros(fromScaledBigInt(roundedScaled, decimals));
}

/**
 * Arredonda `valueStr` PRA CIMA pro múltiplo de `stepStr` mais próximo,
 * sem ponto flutuante. Nunca devolve um valor MENOR que o original --
 * complemento de floorToStep, usado onde subestimar seria o erro
 * perigoso: preço de referência pro cálculo de notional (subestimar
 * preço subestimaria exposição) e stop-loss de posição comprada
 * (Buy/Long), onde "não afrouxar a proteção" significa nunca arredondar
 * pra baixo do que foi pedido.
 */
function ceilToStep(valueStr, stepStr, field = "value") {
  const value = parseStrictDecimal(valueStr, field);
  const step = parseStrictDecimal(stepStr, `${field}Step`);
  const decimals = Math.max(decimalsOf(value), decimalsOf(step));
  const valueScaled = toScaledBigInt(value, decimals);
  const stepScaled = toScaledBigInt(step, decimals);
  if (stepScaled === 0n) throw new InvalidDecimalError(`${field}Step`, stepStr, "step não pode ser zero");
  const remainder = valueScaled % stepScaled;
  const ceiledScaled = remainder === 0n ? valueScaled : valueScaled - remainder + stepScaled;
  return trimTrailingZeros(fromScaledBigInt(ceiledScaled, decimals));
}

/**
 * Multiplica dois decimais em string sem ponto flutuante -- usado pro
 * cálculo de notional (qty × price). Resultado na escala combinada,
 * zeros à direita removidos (nunca muda o valor, só a representação).
 */
function multiplyDecimalStrings(aStr, bStr, fieldA = "a", fieldB = "b") {
  const a = parseStrictDecimal(aStr, fieldA);
  const b = parseStrictDecimal(bStr, fieldB);
  const decimalsA = decimalsOf(a);
  const decimalsB = decimalsOf(b);
  const aScaled = toScaledBigInt(a, decimalsA);
  const bScaled = toScaledBigInt(b, decimalsB);
  const productScaled = aScaled * bScaled;
  return trimTrailingZeros(fromScaledBigInt(productScaled, decimalsA + decimalsB));
}

/** Como parseStrictDecimal, mas aceita "0" (usado pra acumuladores que começam em zero -- exposição atual antes de qualquer posição). */
function parseNonNegativeDecimalAllowZero(raw, field = "value") {
  if (raw === "0" || raw === 0) return "0";
  return parseStrictDecimal(raw, field);
}

/** Soma dois decimais em string sem ponto flutuante -- usado pra acumular exposição (posição + ordens abertas + nova ordem). Aceita "0" em qualquer um dos dois lados (acumulador começando vazio). */
function addDecimalStrings(aStr, bStr, fieldA = "a", fieldB = "b") {
  const a = parseNonNegativeDecimalAllowZero(aStr, fieldA);
  const b = parseNonNegativeDecimalAllowZero(bStr, fieldB);
  const decimals = Math.max(decimalsOf(a), decimalsOf(b));
  const sumScaled = toScaledBigInt(a, decimals) + toScaledBigInt(b, decimals);
  return trimTrailingZeros(fromScaledBigInt(sumScaled, decimals));
}

function compareDecimalStrings(a, b) {
  // Ambos já validados/normalizados (sem sinal negativo, sem notação
  // científica) -- comparação decimal segura via BigInt na escala comum.
  const decimals = Math.max(decimalsOf(a), decimalsOf(b));
  const aScaled = toScaledBigInt(a, decimals);
  const bScaled = toScaledBigInt(b, decimals);
  if (aScaled < bScaled) return -1;
  if (aScaled > bScaled) return 1;
  return 0;
}

/**
 * Valida uma quantidade PROPOSTA contra as regras do instrumento
 * (qtyStep/minOrderQty/maxOrderQty, todos strings vindas da Bybit --
 * lib/bybit.js::getInstrumentInfo). Arredonda pra baixo pro qtyStep;
 * se o resultado ficar abaixo do mínimo, REJEITA (nunca empurra pra
 * cima); se exceder o máximo, REJEITA. Devolve a quantidade final como
 * STRING.
 */
function validateInstrumentQty({ qty, qtyStep, minOrderQty, maxOrderQty }) {
  const parsedQty = parseStrictDecimal(qty, "qty");
  const flooredQty = floorToStep(parsedQty, qtyStep, "qty");

  if (compareDecimalStrings(flooredQty, "0") <= 0) {
    throw new QuantityBelowMinimumError(flooredQty, minOrderQty ?? qtyStep);
  }
  if (minOrderQty !== undefined && minOrderQty !== null) {
    const parsedMin = parseStrictDecimal(minOrderQty, "minOrderQty");
    if (compareDecimalStrings(flooredQty, parsedMin) < 0) {
      throw new QuantityBelowMinimumError(flooredQty, parsedMin);
    }
  }
  if (maxOrderQty !== undefined && maxOrderQty !== null) {
    const parsedMax = parseStrictDecimal(maxOrderQty, "maxOrderQty");
    if (compareDecimalStrings(flooredQty, parsedMax) > 0) {
      throw new QuantityAboveMaximumError(flooredQty, parsedMax);
    }
  }
  return flooredQty;
}

module.exports = {
  InvalidDecimalError,
  QuantityBelowMinimumError,
  QuantityAboveMaximumError,
  parseStrictDecimal,
  parseNonNegativeDecimalAllowZero,
  floorToStep,
  ceilToStep,
  roundToStep,
  multiplyDecimalStrings,
  addDecimalStrings,
  compareDecimalStrings,
  validateInstrumentQty,
};

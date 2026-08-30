// Produtor operacional do snapshot confiável do perfil demo (item 3 da
// Rodada 4) -- orquestra as leituras privadas Demo autorizadas (wallet,
// posições, ordens abertas) + a metadata pública do instrumento, e só
// então grava o snapshot atômico (lib/demoAccountSnapshot.js).
//
// Fluxo exigido: leituras privadas Demo -> metadata pública do
// instrumento -> montar e gravar o snapshot -> só DEPOIS a estratégia
// pode propor uma ordem (index.js::openPosition chama isto ANTES de
// bybit.placeOrder, nunca depois). Ações defensivas (fechar/reduzir/
// cancelar) NUNCA passam por aqui -- usam a melhor informação disponível
// e não dependem de snapshot fresco (ver lib/demoOrderGate.js).
//
// Se QUALQUER leitura falhar ou vier incompleta, este módulo LANÇA e
// NUNCA grava -- nunca "tenta de novo com o que tem" nem reaproveita
// silenciosamente um snapshot velho pra autorizar aumento de exposição.
// O snapshot anterior (se houver) permanece intocado no disco e
// naturalmente perde validade pela idade
// (lib/demoAccountSnapshot.js::DEFAULT_MAX_SNAPSHOT_AGE_MS) -- é
// exatamente esse envelhecimento natural, nunca uma reescrita silenciosa,
// que faz lib/demoOrderGate.js bloquear a próxima tentativa de aumento
// de exposição enquanto o refresh não for bem-sucedido de novo.
const bybit = require("./bybit");
const decimal = require("./decimalSafety");
const { captureDemoAccountSnapshot } = require("./demoAccountSnapshot");

class DemoSnapshotRefreshFailedError extends Error {
  constructor(cause) {
    super(`Falha ao atualizar o snapshot da conta Demo -- nenhuma ordem será proposta neste ciclo (${cause.message}).`);
    this.name = this.constructor.name;
    this.code = "DEMO_SNAPSHOT_REFRESH_FAILED";
    this.cause = cause;
  }
}

async function refreshDemoAccountSnapshot({ env = process.env, symbol, now = Date.now() } = {}) {
  try {
    return await captureDemoAccountSnapshot({
      env,
      symbol,
      now,
      getWalletBalance: bybit.getWalletBalance,
      getPositions: bybit.getPositions,
      getOpenOrders: bybit.getOpenOrders,
      getInstrumentInfo: bybit.getInstrumentInfo,
    });
  } catch (err) {
    throw new DemoSnapshotRefreshFailedError(err);
  }
}

/**
 * A resposta 200/retCode=0 do POST de set-leverage NUNCA é suficiente
 * sozinha (item 4 da Rodada 6) -- depois que bybit.setLeverage() aceita
 * a mutação (já passou pelo gate SAFE_LEVERAGE_REDUCTION, sem rede
 * nenhuma antes disso), este módulo é OBRIGADO a fazer uma leitura
 * privada nova e capturar um snapshot novo (nunca reaproveitar o
 * snapshot pré-mutação, que ficou stale no instante em que a leverage
 * mudou) e só then confirmar, pela leverage efetiva observada nesse
 * snapshot novo, que o valor pedido realmente colou. Qualquer
 * divergência -- inclusive symbolState nulo/leverage efetiva
 * desconhecida no snapshot novo -- lança LeverageReductionNotConfirmedError,
 * nunca finge sucesso.
 */
class LeverageReductionNotConfirmedError extends Error {
  constructor(symbol, requestedLeverage, observedLeverage) {
    super(
      `Redução de leverage de ${symbol} não pôde ser confirmada por leitura fresca da conta Demo: solicitado="${requestedLeverage}", observado=${observedLeverage === null ? "desconhecido" : `"${observedLeverage}"`} -- a resposta do POST nunca é suficiente sozinha.`
    );
    this.name = this.constructor.name;
    this.code = "DEMO_LEVERAGE_REDUCTION_NOT_CONFIRMED";
    this.symbol = symbol;
    this.requestedLeverage = requestedLeverage;
    this.observedLeverage = observedLeverage;
  }
}

async function reduceLeverageSafely({ env = process.env, symbol, leverage, now = Date.now() } = {}) {
  const leverageStr = decimal.parseStrictDecimal(leverage, "leverage"); // formato inválido nunca chega a tentar mutação nenhuma

  await bybit.setLeverage(symbol, leverageStr); // passa pelo gate SAFE_LEVERAGE_REDUCTION inteiro ANTES de qualquer HMAC/Axios -- ver lib/demoOrderGate.js

  const confirmedSnapshot = await refreshDemoAccountSnapshot({ env, symbol, now: Date.now() }); // leitura NOVA, obrigatória -- nunca reaproveita o snapshot pré-mutação
  const observed = confirmedSnapshot.symbolState ? confirmedSnapshot.symbolState.effectiveLeverage : null;
  if (observed === null || observed === undefined || decimal.compareDecimalStrings(observed, leverageStr) !== 0) {
    throw new LeverageReductionNotConfirmedError(symbol, leverageStr, observed ?? null);
  }
  return confirmedSnapshot;
}

module.exports = { refreshDemoAccountSnapshot, DemoSnapshotRefreshFailedError, reduceLeverageSafely, LeverageReductionNotConfirmedError };

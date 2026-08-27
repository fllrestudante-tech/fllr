const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveTargetChannels } = require("../../telegram-radar/watch");

// dialogs fake -- nunca uma conexão real com o Telegram. Formato mínimo que
// resolveTargetChannels lê: {id, title, isChannel, isGroup}.
function dialog(id, title, { isChannel = true, isGroup = false } = {}) {
  return { id, title, isChannel, isGroup };
}

test("uma correspondência única e inequívoca -- preserva o comportamento atual (targets = [o único match])", () => {
  const dialogs = [dialog(1, "Velatrader Squad Oficial 🦈"), dialog(2, "Outro Canal Qualquer")];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].title, "Velatrader Squad Oficial 🦈");
});

test("variação visual mínima do título (emoji, espaços extras, caixa) ainda casa -- correspondência tolerante preservada", () => {
  const dialogs = [dialog(1, "  Velatrader Squad Oficial 🦈🚀  ")];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, true);
  assert.equal(result.targets[0].title, "  Velatrader Squad Oficial 🦈🚀  ");
});

test("zero correspondências -- falha de forma segura (ok:false), sem nenhum target escolhido", () => {
  const dialogs = [dialog(1, "Grupo Completamente Diferente")];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.zeroMatches, ["velatrader squad oficial"]);
  assert.deepEqual(result.ambiguousMatches, []);
  assert.equal(result.targets, undefined);
});

test("múltiplas correspondências para o mesmo nome pedido -- falha de forma segura, NUNCA escolhe um dos dois silenciosamente", () => {
  const dialogs = [
    dialog(1, "Velatrader Squad Oficial 🦈"),
    dialog(2, "Velatrader Squad Oficial (Backup)"),
  ];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.zeroMatches, []);
  assert.equal(result.ambiguousMatches.length, 1);
  assert.equal(result.ambiguousMatches[0].name, "velatrader squad oficial");
  assert.deepEqual(
    result.ambiguousMatches[0].titles.sort(),
    ["Velatrader Squad Oficial (Backup)", "Velatrader Squad Oficial 🦈"].sort()
  );
  assert.equal(result.targets, undefined); // nenhum target parcial -- nem o "primeiro" nem nenhum
});

test("grupo semelhante mas não autorizado (nome parcial, não contém a substring completa) -- corretamente excluído, nunca selecionado", () => {
  const dialogs = [
    dialog(1, "Velatrader Squad Oficial 🦈"), // autorizado
    dialog(2, "Velatrader Trading Group"), // semelhante no nome, mas não contém "squad oficial" -- não deve casar
    dialog(3, "Squad Oficial de Outro Projeto"), // não contém "velatrader" -- não deve casar
  ];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].title, "Velatrader Squad Oficial 🦈");
});

test("DM individual (não é canal nem grupo) nunca é selecionado, mesmo que o título bata por acaso", () => {
  const dialogs = [
    dialog(1, "Velatrader Squad Oficial 🦈", { isChannel: true, isGroup: false }),
    dialog(2, "Velatrader Squad Oficial", { isChannel: false, isGroup: false }), // DM, título coincide, mas nunca deveria ser alvo
  ];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  // Sem a exclusão de DM, isso seria ambíguo (2 candidatos); com a exclusão, resolve para exatamente 1 -- prova que o DM foi corretamente descartado do pool de candidatos.
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].id, 1);
});

test("nenhuma conexão real com o Telegram é necessária -- resolveTargetChannels é pura, só lê o array recebido", () => {
  // Prova por construção: a função não importa TelegramClient nem faz I/O --
  // se este teste rodar sem travar/exigir rede, a garantia está satisfeita.
  const dialogs = [dialog(1, "Velatrader Squad Oficial")];
  const result = resolveTargetChannels({ dialogs, targetChannelNames: ["velatrader squad oficial"] });
  assert.equal(result.ok, true);
});

test("múltiplos nomes pedidos: um resolve único, outro é ambíguo -- resolução INTEIRA falha (nunca segue parcialmente)", () => {
  const dialogs = [
    dialog(1, "Velatrader Squad Oficial 🦈"),
    dialog(2, "Outro Canal A"),
    dialog(3, "Outro Canal B"),
  ];
  const result = resolveTargetChannels({
    dialogs,
    targetChannelNames: ["velatrader squad oficial", "outro canal"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ambiguousMatches.length, 1);
  assert.equal(result.ambiguousMatches[0].name, "outro canal");
  assert.equal(result.targets, undefined); // "velatrader squad oficial" NÃO é aceito parcialmente
});

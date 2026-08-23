// Parser puro e agregador do stream `--json` do Codex CLI -- sem I/O, sem
// spawn, sem rede. Recebe chunks de texto/Buffer possivelmente fragmentados
// no meio de uma linha OU no meio de um caractere UTF-8 multibyte (garantia
// normal de stdout de processo), bufferiza o resto incompleto, e só tenta
// JSON.parse em linha completa (terminada em \n).
//
// Não guarda a lista de eventos brutos -- agrega em tempo real (primeiro
// thread_id, última agent_message.text, último turn.completed.usage,
// contagem por type) pra nunca reter payload completo de eventos
// desconhecidos nem crescer sem limite com um processo que produza saída
// infinita/corrompida.
const { StringDecoder } = require("node:string_decoder");

const MAX_LINE_LENGTH = 1_000_000; // 1MB por linha
const MAX_BUFFER_LENGTH = 2_000_000; // 2MB de linha incompleta ainda sem \n
const MAX_EVENTS = 10_000; // teto de eventos JSONL válidos processados
const MAX_TRACKED_TYPES = 50; // teto de chaves distintas em eventTypeCounts
const MAX_EVENT_TYPE_LENGTH = 128; // teto de tamanho da string `type` em si
const MAX_ERRORS = 100; // teto de erros de parsing antes de desistir do stream

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

/**
 * Normaliza só os 5 campos numéricos conhecidos de usage -- aceita apenas
 * número finito e não-negativo (tokens nunca são negativos), truncado pra
 * inteiro; qualquer coisa fora disso (ausente, string, negativo, NaN,
 * Infinity) vira 0. Ignora silenciosamente qualquer campo extra que o Codex
 * venha a adicionar no futuro (não é responsabilidade deste módulo validar
 * o schema completo).
 */
function normalizeUsage(rawUsage) {
  const usage = {};
  for (const field of USAGE_FIELDS) {
    const value = rawUsage?.[field];
    const isValid = typeof value === "number" && Number.isFinite(value) && value >= 0;
    usage[field] = isValid ? Math.trunc(value) : 0;
  }
  return usage;
}

function createJsonlParser(options = {}) {
  const maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH;
  const maxBufferLength = options.maxBufferLength ?? MAX_BUFFER_LENGTH;
  const maxEvents = options.maxEvents ?? MAX_EVENTS;
  const maxTrackedTypes = options.maxTrackedTypes ?? MAX_TRACKED_TYPES;
  const maxEventTypeLength = options.maxEventTypeLength ?? MAX_EVENT_TYPE_LENGTH;
  const maxErrors = options.maxErrors ?? MAX_ERRORS;

  const decoder = new StringDecoder("utf8");
  // Trava no tipo do primeiro push() -- misturar Buffer e string na mesma
  // instância deixaria o StringDecoder (que guarda bytes pendentes de um
  // caractere multibyte cortado) fora de sincronia com chunks que já
  // chegaram decodificados, podendo inverter/corromper a ordem dos bytes.
  let inputMode = null; // "buffer" | "string"

  let buffer = "";
  let threadId = null;
  let lastAgentMessageText = null;
  let lastUsage = null;
  let eventCount = 0;
  let errorCount = 0;
  let untrackedTypeCount = 0;
  // Object.create(null): `type` vem de fora (o processo Codex) -- uma chave
  // como "__proto__" não pode interferir no protótipo deste objeto.
  const eventTypeCounts = Object.create(null);
  const errorCodesSeen = new Set();
  // Uma vez true, nenhum evento novo é processado -- o resultado final fica
  // marcado como não-confiável em vez de fingir que só o que coube dentro
  // do limite representa a execução inteira.
  let overflow = false;

  function recordError(code) {
    errorCount += 1;
    errorCodesSeen.add(code);
    if (errorCount >= maxErrors && !overflow) {
      overflow = true;
      buffer = "";
      errorCodesSeen.add("AGENTROUTER_JSONL_ERROR_LIMIT");
    }
  }

  function trackType(type) {
    if (!Object.hasOwn(eventTypeCounts, type)) {
      if (Object.keys(eventTypeCounts).length >= maxTrackedTypes) {
        untrackedTypeCount += 1;
        return;
      }
      eventTypeCounts[type] = 0;
    }
    eventTypeCounts[type] += 1;
  }

  function extractAgentMessageText(evt) {
    if (evt.type !== "item.completed") return undefined;
    const item = evt.item;
    if (!item || item.type !== "agent_message") return undefined;
    if (typeof item.text !== "string") return undefined;
    return item.text;
  }

  function processLine(line) {
    if (overflow) return;

    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.length > maxLineLength) {
      recordError("AGENTROUTER_JSONL_LINE_TOO_LONG");
      return;
    }

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      recordError("AGENTROUTER_JSONL_INVALID");
      return;
    }
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
      recordError("AGENTROUTER_JSONL_INVALID");
      return;
    }
    // obj.type já é string aqui, mas sem teto de tamanho ele poderia virar
    // uma chave gigante e permanente em eventTypeCounts (até maxLineLength
    // inteiro) -- rejeitado como evento inválido antes de qualquer uso.
    if (!obj.type || obj.type.length > maxEventTypeLength) {
      recordError("AGENTROUTER_JSONL_INVALID_TYPE");
      return;
    }

    // Só agora, com um evento JSON válido e reconhecível em mãos, checa o
    // teto -- uma linha vazia/inválida depois do limite não deve por si só
    // acionar overflow.
    if (eventCount >= maxEvents) {
      overflow = true;
      buffer = "";
      errorCodesSeen.add("AGENTROUTER_JSONL_EVENT_LIMIT");
      return;
    }

    eventCount += 1;
    trackType(obj.type);

    if (obj.type === "thread.started") {
      if (threadId === null && typeof obj.thread_id === "string") {
        threadId = obj.thread_id;
      }
      return;
    }

    const agentMessageText = extractAgentMessageText(obj);
    if (agentMessageText !== undefined) {
      lastAgentMessageText = agentMessageText;
      return;
    }

    if (obj.type === "turn.completed") {
      lastUsage = normalizeUsage(obj.usage);
      return;
    }
    // Evento reconhecido pelo protocolo (tem `type`) mas irrelevante pra
    // este parser (ex: item.started, turn.started, command_execution) --
    // já contabilizado em eventTypeCounts acima, nunca guarda o objeto.
  }

  function push(chunk) {
    const isBufferChunk = Buffer.isBuffer(chunk);
    const isStringChunk = typeof chunk === "string";
    if (!isBufferChunk && !isStringChunk) {
      throw new TypeError("jsonlParser.push: chunk deve ser string ou Buffer");
    }

    const mode = isBufferChunk ? "buffer" : "string";
    if (inputMode === null) {
      inputMode = mode;
    } else if (inputMode !== mode) {
      throw new TypeError(`jsonlParser.push: modo fixado em "${inputMode}"; não é permitido misturar com "${mode}"`);
    }

    if (overflow) return;

    // StringDecoder segura bytes de um caractere UTF-8 multibyte cortado
    // entre dois chunks -- só entra em jogo pra Buffer.
    const text = isBufferChunk ? decoder.write(chunk) : chunk;
    buffer += text;

    // Processa TODAS as linhas completas primeiro -- um chunk grande com
    // muitas linhas pequenas e válidas nunca deve ser rejeitado por
    // maxBufferLength; o limite se aplica só ao restante sem \n ainda.
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      processLine(line);
      if (overflow) return;
    }

    if (buffer.length > maxBufferLength) {
      overflow = true;
      errorCodesSeen.add("AGENTROUTER_JSONL_BUFFER_LIMIT");
      buffer = "";
    }
  }

  // Chamar quando o processo terminar -- cobre o caso de a última linha não
  // vir terminada em \n, e finaliza o StringDecoder (bytes finais de um
  // caractere multibyte truncado no fim real do stream).
  function flush() {
    const tail = decoder.end();
    if (tail) buffer += tail;
    if (!overflow && buffer.trim()) processLine(buffer);
    buffer = "";
  }

  /**
   * complete=true exige texto final, turn.completed, ZERO erro de parsing
   * registrado e ausência de overflow -- um stream que teve qualquer linha
   * corrompida/truncada nunca deve parecer uma resposta íntegra só porque
   * uma agent_message válida apareceu em algum ponto antes da corrupção.
   */
  function getResult() {
    return {
      threadId,
      text: lastAgentMessageText,
      usage: lastUsage,
      complete: lastAgentMessageText !== null && lastUsage !== null && errorCount === 0 && !overflow,
      eventCount,
      eventTypeCounts: { ...eventTypeCounts },
      untrackedTypeCount,
      errorCount,
      errors: Array.from(errorCodesSeen),
      overflow,
    };
  }

  return { push, flush, getResult };
}

module.exports = { createJsonlParser, normalizeUsage, USAGE_FIELDS };

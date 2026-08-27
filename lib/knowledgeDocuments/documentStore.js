// Persistência SQLite dos documentos da Base de Conhecimento Velatrader.
// NUNCA lê arquivo do disco, NUNCA calcula hash sozinho, NUNCA faz
// requisição de rede -- todo campo (incluindo sha256) é fornecido por quem
// chama. Este módulo só valida e persiste metadados já coletados
// externamente, na mesma disciplina de lib/collectors/telegramStore.js
// (ingestão nunca decide relevância, só grava o que já foi decidido fora).
const { ID_PATTERN } = require("../registry/researchObject");
const { isSafeLocalRelativePath, isSafeManualReference } = require("./pathSafety");
// Reaproveita SÓ a validação estrutural de URL (sem DNS, sem HTTP) -- a
// mesma proteção contra SSRF já usada pelo resto do projeto. Nunca
// `validateHop`/`resolveAndValidateAddresses` aqui -- esses fazem
// resolução DNS, que esta camada explicitamente não faz.
const { validateInitialUrl } = require("../collectors/sources/urlSafety");
const { INITIAL_STATE, assertValidTransition } = require("./documentStates");

const TYPES = new Set(["pdf", "video", "course_export", "transcript"]);
const ORIGINS = new Set(["personal_upload", "external_reference", "platform_export"]);
const OWNERSHIP_LICENSES = new Set(["private_personal", "user_created", "third_party_licensed", "unknown"]);
const PRIVACY_CLASSIFICATIONS = new Set(["private_personal", "private_sensitive", "internal_only", "shareable"]);
const RETENTION_POLICIES = new Set(["indefinite_local_only", "delete_after_review", "delete_after_days"]);
// Discriminador explícito de `sourceReference` -- nunca inferido pelo
// formato da string. Cada valor tem sua própria gramática de validação
// (ver resolveSourceReference abaixo); um valor incompatível com o tipo
// declarado é sempre rejeitado, nunca reinterpretado como outro formato.
const REFERENCE_TYPES = new Set(["local_relative_path", "external_https_url", "manual_reference"]);
const SHA256_RE = /^[0-9a-f]{64}$/;

class DocumentValidationError extends Error {
  constructor(field, detail) {
    super(`Invalid field "${field}": ${detail}`);
    this.name = this.constructor.name;
    this.code = "DOCUMENT_VALIDATION_ERROR";
    this.field = field;
  }
}

class DuplicateHashError extends Error {
  constructor() {
    super("A document with this hash already exists"); // NUNCA inclui o hash na mensagem por conveniência de log -- disponível em .sha256 pra quem trata o erro
    this.name = this.constructor.name;
    this.code = "DUPLICATE_HASH";
  }
}

class DocumentNotFoundError extends Error {
  constructor() {
    super("Document not found");
    this.name = this.constructor.name;
    this.code = "DOCUMENT_NOT_FOUND";
  }
}

class ContentIntegrityAlreadyRegisteredError extends Error {
  constructor() {
    super("Content integrity (hash and/or size) is already registered for this document -- it can never be silently overwritten"); // nunca inclui hash/tamanho/caminho na mensagem
    this.name = this.constructor.name;
    this.code = "CONTENT_INTEGRITY_ALREADY_REGISTERED";
  }
}

function requireNonEmptyString(value, field, maxLen) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLen) {
    throw new DocumentValidationError(field, `must be a non-empty string (max ${maxLen} chars)`);
  }
}

function requireInSet(value, field, set) {
  if (!set.has(value)) throw new DocumentValidationError(field, `must be one of: ${[...set].join(", ")}`);
}

/**
 * Valida `referenceType` + `sourceReference` juntos (o segundo só faz
 * sentido interpretado à luz do primeiro -- nunca "adivinha" o formato) e
 * devolve a forma a gravar: `{ sourceReference, sourceReferenceOriginal }`.
 *   - local_relative_path -- devolvido tal como veio, sem transformação
 *     (quem chama já deve ter passado por pathSafety.toSafeSourceReference
 *     se partiu de um caminho absoluto).
 *   - external_https_url -- validado estruturalmente por
 *     urlSafety.validateInitialUrl (sem DNS, sem HTTP); `sourceReference`
 *     vira a forma CANÔNICA devolvida por ela (sem fragmento, com query
 *     string preservada); `sourceReferenceOriginal` só é preenchido se a
 *     string original recebida era diferente da canônica (hoje isso só
 *     acontece quando havia fragmento).
 *   - manual_reference -- devolvido tal como veio, desde que não pareça
 *     caminho nem URL.
 */
function resolveSourceReference(referenceType, sourceReference) {
  if (referenceType === "local_relative_path") {
    if (!isSafeLocalRelativePath(sourceReference)) {
      throw new DocumentValidationError(
        "sourceReference",
        "must be a safe local relative path (no absolute path, no drive letter, no UNC/device path, no traversal, no URL scheme, no '\\')"
      );
    }
    return { sourceReference, sourceReferenceOriginal: null };
  }
  if (referenceType === "external_https_url") {
    const result = validateInitialUrl(sourceReference);
    if (!result.ok) {
      throw new DocumentValidationError("sourceReference", `must be a valid https URL (${result.code})`);
    }
    return {
      sourceReference: result.url,
      sourceReferenceOriginal: sourceReference !== result.url ? sourceReference : null,
    };
  }
  if (referenceType === "manual_reference") {
    if (!isSafeManualReference(sourceReference)) {
      throw new DocumentValidationError("sourceReference", "must be safe free text (must not look like a local path or a URL)");
    }
    return { sourceReference, sourceReferenceOriginal: null };
  }
  throw new DocumentValidationError("referenceType", `must be one of: ${[...REFERENCE_TYPES].join(", ")}`);
}

function validateNewDocumentFields(fields) {
  requireNonEmptyString(fields.id, "id", 64);
  requireInSet(fields.type, "type", TYPES);
  requireNonEmptyString(fields.title, "title", 300);
  requireInSet(fields.origin, "origin", ORIGINS);
  requireInSet(fields.ownershipLicense, "ownershipLicense", OWNERSHIP_LICENSES);
  requireInSet(fields.privacyClassification, "privacyClassification", PRIVACY_CLASSIFICATIONS);
  requireInSet(fields.referenceType, "referenceType", REFERENCE_TYPES);

  // sha256 é o hash de CONTEÚDO real, nunca da identidade/referência da
  // fonte -- OPCIONAL na descoberta (o material pode estar só
  // 'discovered'/'cataloged', sem nenhum conteúdo obtido ainda). Quando
  // ausente (null/undefined), fica NULL no banco -- nunca um placeholder
  // sintético. Quando presente, precisa continuar sendo exatamente 64 hex
  // minúsculos.
  if (fields.sha256 != null && (typeof fields.sha256 !== "string" || !SHA256_RE.test(fields.sha256))) {
    throw new DocumentValidationError("sha256", "when provided, must be exactly 64 lowercase hex characters (omit/null if no content has been obtained yet)");
  }
  // sizeBytes segue a MESMA distinção de sha256: NULL = tamanho ainda
  // desconhecido (nenhum conteúdo obtido), 0 = conhecido e comprovadamente
  // vazio, positivo = tamanho real conhecido -- NUNCA 0 representando
  // "desconhecido".
  if (fields.sizeBytes != null && (!Number.isInteger(fields.sizeBytes) || fields.sizeBytes < 0)) {
    throw new DocumentValidationError("sizeBytes", "when provided, must be a non-negative integer (omit/null if no content has been obtained yet)");
  }
  // sha256 e sizeBytes são SEMPRE gravados juntos -- integridade é uma
  // unidade só, nunca hash sem tamanho nem tamanho sem hash.
  if ((fields.sha256 == null) !== (fields.sizeBytes == null)) {
    throw new DocumentValidationError("sha256/sizeBytes", "must both be null (no content obtained yet) or both be present together -- never one without the other");
  }
  if (fields.pageCount != null && fields.durationSeconds != null) {
    throw new DocumentValidationError("pageCount/durationSeconds", "cannot both be set on the same document");
  }
  if (fields.pageCount != null && (!Number.isInteger(fields.pageCount) || fields.pageCount <= 0)) {
    throw new DocumentValidationError("pageCount", "must be a positive integer or omitted");
  }
  if (fields.durationSeconds != null && (!Number.isInteger(fields.durationSeconds) || fields.durationSeconds <= 0)) {
    throw new DocumentValidationError("durationSeconds", "must be a positive integer or omitted");
  }
  requireInSet(fields.retentionPolicy, "retentionPolicy", RETENTION_POLICIES);
  if (fields.retentionPolicy === "delete_after_days" && !(Number.isInteger(fields.retentionDays) && fields.retentionDays > 0)) {
    throw new DocumentValidationError("retentionDays", "required (positive integer) when retentionPolicy is 'delete_after_days'");
  }
  if (fields.researchObjectId != null && (typeof fields.researchObjectId !== "string" || !ID_PATTERN.test(fields.researchObjectId))) {
    throw new DocumentValidationError("researchObjectId", "must be kebab-case, matching lib/registry ID_PATTERN");
  }
  if (fields.language != null) requireNonEmptyString(fields.language, "language", 10);
}

function insertEvent(db, { documentId, fromStatus, toStatus, actorType, actorReference, reason, errorCode, nowMs }) {
  db.prepare(
    `INSERT INTO knowledge_document_events
      (document_id, from_status, to_status, actor_type, actor_reference, reason, error_code, occurred_at, occurred_at_ms)
     VALUES (@documentId, @fromStatus, @toStatus, @actorType, @actorReference, @reason, @errorCode, @occurredAt, @occurredAtMs)`
  ).run({
    documentId,
    fromStatus: fromStatus ?? null,
    toStatus,
    actorType,
    actorReference: actorReference ?? null,
    reason: reason ?? null,
    errorCode: errorCode ?? null,
    occurredAt: new Date(nowMs).toISOString(),
    occurredAtMs: nowMs,
  });
}

function getDocument(db, id) {
  return db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id) || null;
}

function listDocuments(db, { status } = {}) {
  if (status) {
    return db.prepare("SELECT * FROM knowledge_documents WHERE status = ? ORDER BY discovered_at_ms").all(status);
  }
  return db.prepare("SELECT * FROM knowledge_documents ORDER BY discovered_at_ms").all();
}

function listDocumentEvents(db, documentId) {
  return db.prepare("SELECT * FROM knowledge_document_events WHERE document_id = ? ORDER BY occurred_at_ms, id").all(documentId);
}

/**
 * Cria um documento novo, sempre em `discovered` (nunca aceita um status
 * inicial diferente -- "nenhum material começa aprovado" é garantido aqui,
 * não só documentado). Hash duplicado (mesmo conteúdo já catalogado antes,
 * ainda que com id/título diferentes) é rejeitado explicitamente -- nunca
 * silenciosamente mesclado nem criado como linha duplicada. Todo o INSERT
 * (documento + evento "discovered") acontece em UMA transação.
 */
function discoverDocument(db, fields, { now = () => Date.now() } = {}) {
  validateNewDocumentFields(fields);
  const { sourceReference, sourceReferenceOriginal } = resolveSourceReference(fields.referenceType, fields.sourceReference);

  // Duplicidade só é verificável (e só faz sentido) entre hashes REAIS --
  // múltiplos documentos sem hash (NULL) nunca são "duplicados" entre si
  // por esse critério. O índice único parcial no banco
  // (idx_knowledge_documents_sha256) impõe a mesma regra na escrita, esta
  // checagem só antecipa o erro sanitizado antes de tocar o banco.
  if (fields.sha256 != null) {
    const duplicate = db.prepare("SELECT id FROM knowledge_documents WHERE sha256 = ?").get(fields.sha256);
    if (duplicate) throw new DuplicateHashError();
  }

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();

  const run = db.transaction(() => {
    try {
      db.prepare(
        `INSERT INTO knowledge_documents
          (id, research_object_id, type, title, origin, ownership_license, privacy_classification,
           reference_type, source_reference, source_reference_original, sha256, size_bytes, page_count, duration_seconds, language, version,
           status, discovered_at, discovered_at_ms, retention_policy, retention_days, updated_at, updated_at_ms)
         VALUES
          (@id, @researchObjectId, @type, @title, @origin, @ownershipLicense, @privacyClassification,
           @referenceType, @sourceReference, @sourceReferenceOriginal, @sha256, @sizeBytes, @pageCount, @durationSeconds, @language, @version,
           @status, @discoveredAt, @discoveredAtMs, @retentionPolicy, @retentionDays, @updatedAt, @updatedAtMs)`
      ).run({
        id: fields.id,
        researchObjectId: fields.researchObjectId ?? null,
        type: fields.type,
        title: fields.title,
        origin: fields.origin,
        ownershipLicense: fields.ownershipLicense,
        privacyClassification: fields.privacyClassification,
        referenceType: fields.referenceType,
        sourceReference,
        sourceReferenceOriginal,
        sha256: fields.sha256 ?? null,
        sizeBytes: fields.sizeBytes ?? null,
        pageCount: fields.pageCount ?? null,
        durationSeconds: fields.durationSeconds ?? null,
        language: fields.language ?? null,
        version: fields.version ?? 1,
        status: INITIAL_STATE,
        discoveredAt: nowIso,
        discoveredAtMs: nowMs,
        retentionPolicy: fields.retentionPolicy,
        retentionDays: fields.retentionDays ?? null,
        updatedAt: nowIso,
        updatedAtMs: nowMs,
      });
    } catch (err) {
      if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") throw new DuplicateHashError();
      const sanitized = new Error("Failed to persist document (constraint violation)");
      sanitized.name = "DocumentPersistenceError";
      sanitized.code = "DOCUMENT_PERSISTENCE_ERROR";
      sanitized.cause = err; // detalhe real preservado só pra depuração interna, nunca em .message
      throw sanitized;
    }

    insertEvent(db, {
      documentId: fields.id,
      fromStatus: null,
      toStatus: INITIAL_STATE,
      actorType: "system",
      actorReference: null,
      reason: "discovered",
      errorCode: null,
      nowMs,
    });
  });
  run();

  return getDocument(db, fields.id);
}

/**
 * Aplica uma transição de estado validada (assertValidTransition lança se
 * não for permitida -- nunca aplica parcialmente). UPDATE + evento sempre
 * na mesma transação. Marcos de data (cataloged_at/processed_at/etc) só
 * avançam -- nunca são reescritos por uma transição posterior que não seja
 * a primeira vez que o documento passa por ali.
 */
function transitionDocument(db, id, { toStatus, actorType, actorReference = null, reason = null, errorCode = null, approvedBy = null, now = () => Date.now() }) {
  const current = getDocument(db, id);
  if (!current) throw new DocumentNotFoundError();

  assertValidTransition(current.status, toStatus);

  if (actorType !== "system" && actorType !== "operator") {
    throw new DocumentValidationError("actorType", "must be 'system' or 'operator'");
  }
  // 'rejected' exige ator IDENTIFICÁVEL -- actorType='operator' sozinho não
  // diz QUEM; actorReference precisa ser uma string não-vazia (nunca só
  // espaços), gravada tanto na tabela de eventos quanto exigida aqui.
  if (toStatus === "rejected") {
    if (!reason) throw new DocumentValidationError("reason", "required when transitioning to 'rejected'");
    if (typeof actorReference !== "string" || actorReference.trim().length === 0) {
      throw new DocumentValidationError("actorReference", "required (non-empty) when transitioning to 'rejected' -- actorType alone is not a sufficient identity");
    }
  }
  // 'approved_for_research' exige TUDO simultaneamente: responsável humano
  // (approvedBy) não vazio, motivo (reason) não vazio, e hash de conteúdo
  // REAL já registrado -- data (approved_at) é sempre preenchida abaixo, e
  // o estado anterior permitido já foi garantido por assertValidTransition.
  if (toStatus === "approved_for_research") {
    if (!approvedBy) throw new DocumentValidationError("approvedBy", "required when transitioning to 'approved_for_research'");
    if (!reason) throw new DocumentValidationError("reason", "required when transitioning to 'approved_for_research'");
  }
  // Integridade de conteúdo real (hash E tamanho) é obrigatória antes de
  // 'processed' e de 'approved_for_research' -- nunca antes disso (o
  // documento pode circular livremente em
  // discovered/cataloged/processing_pending sem conteúdo obtido ainda).
  // Verificado aqui em JS (erro sanitizado e específico) ALÉM do CHECK
  // espelhado no schema (defesa em profundidade). A coerência
  // sha256<->size_bytes (sempre juntos) já é garantida na escrita, então
  // checar qualquer um dos dois aqui é equivalente -- checamos ambos por
  // clareza da mensagem de erro.
  if ((toStatus === "processed" || toStatus === "approved_for_research") && (current.sha256 == null || current.size_bytes == null)) {
    throw new DocumentValidationError(
      "sha256/sizeBytes",
      `real content integrity (hash and size) must be registered (see registerContentIntegrity) before transitioning to '${toStatus}'`
    );
  }

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();

  const fieldsToSet = { status: toStatus, updated_at: nowIso, updated_at_ms: nowMs };
  if (current.cataloged_at === null && toStatus !== "discovered") {
    fieldsToSet.cataloged_at = nowIso;
    fieldsToSet.cataloged_at_ms = nowMs;
  }
  if (toStatus === "processed") {
    fieldsToSet.processed_at = nowIso;
    fieldsToSet.processed_at_ms = nowMs;
  }
  if (toStatus === "review_required") {
    fieldsToSet.last_reviewed_at = nowIso;
    fieldsToSet.last_reviewed_at_ms = nowMs;
  }
  if (toStatus === "approved_for_research") {
    fieldsToSet.approved_by = approvedBy;
    fieldsToSet.approved_at = nowIso;
    fieldsToSet.approved_at_ms = nowMs;
    fieldsToSet.approval_reason = reason;
  }
  if (toStatus === "rejected") {
    fieldsToSet.approval_reason = reason;
  }
  if (errorCode) fieldsToSet.last_error_code = errorCode;

  const run = db.transaction(() => {
    const setClause = Object.keys(fieldsToSet)
      .map((key) => `${key} = @${key}`)
      .join(", ");
    db.prepare(`UPDATE knowledge_documents SET ${setClause} WHERE id = @id`).run({ ...fieldsToSet, id });

    insertEvent(db, {
      documentId: id,
      fromStatus: current.status,
      toStatus,
      actorType,
      actorReference,
      reason,
      errorCode,
      nowMs,
    });
  });
  run();

  return getDocument(db, id);
}

/**
 * Registra a INTEGRIDADE COMPLETA de conteúdo (hash + tamanho, sempre
 * juntos) de um documento que foi descoberto sem nenhum dos dois (ex.: uma
 * URL externa catalogada antes de qualquer download). Esta é a ÚNICA
 * operação além de `discoverDocument` que pode gravar `sha256`/`size_bytes`
 * -- uma operação explícita e auditada, nunca implícita numa transição de
 * estado comum, e sempre ATÔMICA (nunca registra um sem o outro -- ver
 * validação abaixo e o CHECK espelhado no schema:
 * `(sha256 IS NULL) = (size_bytes IS NULL)`). NUNCA lê nem calcula o
 * arquivo (mesma disciplina do resto deste módulo) -- hash e tamanho
 * chegam já calculados por quem chama, exatamente como em
 * `discoverDocument`.
 *
 * Rejeita sobrescrita silenciosa: se o documento já tem `sha256` OU
 * `size_bytes` registrados, esta função sempre lança
 * `ContentIntegrityAlreadyRegisteredError` -- mesmo que os valores novos
 * sejam idênticos aos antigos. Corrigir uma integridade errada é
 * deliberadamente FORA do escopo desta operação (exigiria um processo à
 * parte, autorizado explicitamente, não implementado neste commit).
 *
 * UPDATE (hash + tamanho) + evento sempre na MESMA transação (mesmo padrão
 * de `transitionDocument`) -- rollback integral se qualquer parte falhar,
 * inclusive o evento. `from_status`/`to_status` do evento ficam iguais ao
 * status atual (esta operação nunca muda o status por si só). Erros nunca
 * incluem hash, tamanho, caminho pessoal ou qualquer outro detalhe
 * sensível.
 */
function registerContentIntegrity(db, id, { sha256, sizeBytes, actorType, actorReference = null, now = () => Date.now() }) {
  const current = getDocument(db, id);
  if (!current) throw new DocumentNotFoundError();

  if (current.sha256 != null || current.size_bytes != null) throw new ContentIntegrityAlreadyRegisteredError();
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
    throw new DocumentValidationError("sha256", "must be exactly 64 lowercase hex characters");
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new DocumentValidationError("sizeBytes", "must be a non-negative integer");
  }
  if (actorType !== "system" && actorType !== "operator") {
    throw new DocumentValidationError("actorType", "must be 'system' or 'operator'");
  }

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();

  const run = db.transaction(() => {
    try {
      db.prepare(
        "UPDATE knowledge_documents SET sha256 = @sha256, size_bytes = @sizeBytes, updated_at = @updatedAt, updated_at_ms = @updatedAtMs WHERE id = @id"
      ).run({
        sha256,
        sizeBytes,
        updatedAt: nowIso,
        updatedAtMs: nowMs,
        id,
      });
    } catch (err) {
      if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") throw new DuplicateHashError();
      const sanitized = new Error("Failed to persist content integrity (constraint violation)");
      sanitized.name = "DocumentPersistenceError";
      sanitized.code = "DOCUMENT_PERSISTENCE_ERROR";
      sanitized.cause = err; // detalhe real preservado só pra depuração interna, nunca em .message
      throw sanitized;
    }

    insertEvent(db, {
      documentId: id,
      fromStatus: current.status,
      toStatus: current.status,
      actorType,
      actorReference,
      reason: "content_integrity_registered",
      errorCode: null,
      nowMs,
    });
  });
  run();

  return getDocument(db, id);
}

module.exports = {
  discoverDocument,
  transitionDocument,
  registerContentIntegrity,
  getDocument,
  listDocuments,
  listDocumentEvents,
  DocumentValidationError,
  DuplicateHashError,
  DocumentNotFoundError,
  ContentIntegrityAlreadyRegisteredError,
  TYPES,
  ORIGINS,
  OWNERSHIP_LICENSES,
  PRIVACY_CLASSIFICATIONS,
  RETENTION_POLICIES,
  REFERENCE_TYPES,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");
const {
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
} = require("../../lib/knowledgeDocuments/documentStore");

// SQLite REAL, mas SEMPRE em arquivo temporário isolado (os.tmpdir()) --
// nunca data/market.db, nunca qualquer banco persistente do projeto. Mesmo
// padrão de test/aiGateway/agentRouterGate.test.js.
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-cripto10-knowledge-docs-"));
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validFields(overrides = {}) {
  return {
    id: "doc-1",
    type: "pdf",
    title: "Manual de Teste",
    origin: "personal_upload",
    ownershipLicense: "private_personal",
    privacyClassification: "private_personal",
    referenceType: "local_relative_path",
    sourceReference: "ManualDeTeste.pdf",
    sha256: "a".repeat(64),
    sizeBytes: 1000,
    pageCount: 50,
    retentionPolicy: "indefinite_local_only",
    ...overrides,
  };
}

// =====================================================================
// discoverDocument -- criação, sempre em 'discovered'
// =====================================================================

test("discoverDocument: cria documento sempre em 'discovered', nunca aceita status inicial diferente mesmo se fornecido", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, { ...validFields(), status: "approved_for_research" }, { now: () => 1000 });
    assert.equal(doc.status, "discovered"); // campo status extra na entrada é ignorado -- só o construído internamente é usado
  });
});

test("discoverDocument: grava exatamente 1 evento 'discovered' na criação", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    const events = listDocumentEvents(db, "doc-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].from_status, null);
    assert.equal(events[0].to_status, "discovered");
    assert.equal(events[0].actor_type, "system");
  });
});

test("discoverDocument: hash duplicado é rejeitado -- nenhuma linha nova, mensagem nunca inclui o hash", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ id: "doc-1", sha256: "b".repeat(64) }), { now: () => 1000 });
    assert.throws(
      () => discoverDocument(db, validFields({ id: "doc-2", sha256: "b".repeat(64) }), { now: () => 2000 }),
      (err) => {
        assert.ok(err instanceof DuplicateHashError);
        assert.ok(!err.message.includes("b".repeat(64)));
        return true;
      }
    );
    assert.equal(listDocuments(db).length, 1); // nenhuma linha extra foi criada
    assert.equal(getDocument(db, "doc-2"), null);
  });
});

test("discoverDocument: proveniência obrigatória -- ownershipLicense e privacyClassification ausentes falham antes de qualquer escrita", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ ownershipLicense: undefined })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ privacyClassification: undefined })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0); // nada foi persistido
  });
});

test("discoverDocument: sourceReference inseguro (absoluto/travessia) é rejeitado ANTES de tocar o banco", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ sourceReference: "C:\\Users\\Universo\\manual.pdf" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ sourceReference: "../../etc/passwd" })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: vínculo com Registry -- researchObjectId válido (kebab-case) é aceito, formato inválido é rejeitado", () => {
  withTempDb((db) => {
    assert.doesNotThrow(() => discoverDocument(db, validFields({ researchObjectId: "feature-manual-conceito-x" })));
    assert.throws(() => discoverDocument(db, validFields({ id: "doc-2", sha256: "c".repeat(64), researchObjectId: "Nao Kebab!" })), DocumentValidationError);
  });
});

test("discoverDocument: ausência de researchObjectId é permitida -- um documento pode não corresponder a nenhum Research Object ainda (vínculo é sempre opcional, nunca obrigatório)", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, validFields({ researchObjectId: undefined }), { now: () => 1000 });
    assert.equal(doc.research_object_id, null);
  });
});

test("discoverDocument: pageCount e durationSeconds simultâneos são rejeitados", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ pageCount: 10, durationSeconds: 60 })), DocumentValidationError);
  });
});

test("discoverDocument: type/origin/ownershipLicense/privacyClassification/retentionPolicy fora do vocabulário fechado são rejeitados", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ type: "audio" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ origin: "scraped" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ ownershipLicense: "stolen" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ privacyClassification: "public" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ retentionPolicy: "forever_and_ever" })), DocumentValidationError);
  });
});

// =====================================================================
// referenceType -- discriminador local_relative_path / external_https_url /
// manual_reference (revisão focalizada desta rodada)
// =====================================================================

test("discoverDocument: referenceType fora do enum é rejeitado antes de tocar o banco", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "url" })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: referenceType='local_relative_path' -- lista completa de padrões proibidos pedida na revisão é rejeitada, padrões seguros são aceitos", () => {
  withTempDb((db) => {
    const forbidden = [
      "C:\\Users\\Nome\\arquivo.pdf",
      "\\\\servidor\\pasta\\arquivo.pdf",
      "\\\\?\\C:\\arquivo.pdf",
      "..\\arquivo.pdf",
      "pasta\\..\\arquivo.pdf",
      "/pasta/arquivo.pdf",
      "file:///C:/arquivo.pdf",
    ];
    forbidden.forEach((sourceReference, i) => {
      assert.throws(
        () => discoverDocument(db, validFields({ id: `doc-forbidden-${i}`, sha256: `${i}`.repeat(64), sourceReference })),
        DocumentValidationError,
        `"${sourceReference}" deveria ser rejeitado`
      );
    });
    assert.equal(listDocuments(db).length, 0);

    const allowed = ["ManualdoCriptotrader2.0.pdf", "knowledge-input/velatrader/manual.pdf"];
    allowed.forEach((sourceReference, i) => {
      assert.doesNotThrow(() => discoverDocument(db, validFields({ id: `doc-allowed-${i}`, sha256: `a${i}`.repeat(32), sourceReference })));
    });
    assert.equal(listDocuments(db).length, 2);
  });
});

test("discoverDocument: referenceType='external_https_url' -- reutiliza validateInitialUrl (SSRF), representa o vídeo público confirmado nesta sessão sem cadastrar de fato uma fonte real do produto e SEM nenhum valor fictício de integridade", () => {
  withTempDb((db) => {
    // Linha efêmera em banco :memory:/temp, descartada ao fim do teste --
    // NÃO é o cadastro real do vídeo no catálogo do produto (isso segue
    // fora de escopo, conforme instruído: "não cadastre ainda o vídeo no
    // banco"). Isto só prova que o MODELO ESTRUTURAL consegue representar
    // a URL pública confirmada, com t=15s preservado na query (nunca
    // removido como se fosse fragmento). sha256 E size_bytes são NULL de
    // propósito -- o vídeo nunca foi baixado nesta sessão, então não existe
    // integridade de conteúdo real calculada (nem hash, nem tamanho); usar
    // qualquer valor sintético aqui seria exatamente o erro que esta rodada
    // (e a anterior) corrigiram.
    const doc = discoverDocument(
      db,
      validFields({
        id: "doc-youtube-structural-check",
        type: "video",
        title: "Curso Completo de Trading para Iniciantes 2026 (verificação estrutural, não cadastro real)",
        origin: "external_reference",
        ownershipLicense: "third_party_licensed",
        privacyClassification: "shareable",
        referenceType: "external_https_url",
        sourceReference: "https://www.youtube.com/watch?v=thJBGfbQKcg&t=15s",
        sha256: null,
        sizeBytes: null,
        pageCount: null,
        durationSeconds: 4409,
      })
    );
    assert.equal(doc.reference_type, "external_https_url");
    assert.equal(doc.source_reference, "https://www.youtube.com/watch?v=thJBGfbQKcg&t=15s"); // query (t=15s) preservada, não é fragmento
    assert.equal(doc.source_reference_original, null); // idêntico à forma canônica -- não havia fragmento a remover
    assert.equal(doc.sha256, null); // sem conteúdo obtido, sem hash -- nunca um placeholder
    assert.equal(doc.size_bytes, null); // sem conteúdo obtido, sem tamanho -- nunca 0 ou qualquer valor fictício
    assert.equal(doc.status, "discovered"); // permanece só descoberto -- catalogar/processar/aprovar são etapas futuras, fora de escopo aqui
  });
});

test("discoverDocument: referenceType='external_https_url' -- fragmento é removido da forma canônica e preservado separadamente em source_reference_original", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "https://example.com/article#section2" }));
    assert.equal(doc.source_reference, "https://example.com/article"); // canônica, sem fragmento
    assert.equal(doc.source_reference_original, "https://example.com/article#section2"); // original preservado pra auditoria
  });
});

test("discoverDocument: referenceType='external_https_url' -- rejeita esquema não-HTTPS, credenciais embutidas, localhost e porta proibida (mesma proteção SSRF de urlSafety.js)", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "http://example.com/video" })), DocumentValidationError);
    assert.throws(
      () => discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "https://user:pass@example.com/video" })),
      DocumentValidationError
    );
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "https://localhost/video" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "https://example.com:8443/video" })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: referenceType='manual_reference' -- texto livre aceito, caminho/URL disfarçado de manual_reference é rejeitado", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, validFields({ referenceType: "manual_reference", sourceReference: "Transcrição será fornecida manualmente pelo usuário" }));
    assert.equal(doc.reference_type, "manual_reference");
    assert.throws(
      () => discoverDocument(db, validFields({ id: "doc-2", sha256: "b".repeat(64), referenceType: "manual_reference", sourceReference: "C:\\Users\\Nome\\arquivo.pdf" })),
      DocumentValidationError
    );
    assert.throws(
      () => discoverDocument(db, validFields({ id: "doc-3", sha256: "c".repeat(64), referenceType: "manual_reference", sourceReference: "https://example.com/video" })),
      DocumentValidationError
    );
  });
});

test("discoverDocument: referenceType='manual_reference' endurecido -- rejeita nome de arquivo isolado ('manual.pdf') e '/' em qualquer posição ('pasta/manual.pdf')", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "manual_reference", sourceReference: "manual.pdf" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ id: "doc-2", sha256: "b".repeat(64), referenceType: "manual_reference", sourceReference: "pasta/manual.pdf" })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: mismatch entre referenceType e formato de sourceReference nunca é reinterpretado silenciosamente -- sempre rejeitado", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "local_relative_path", sourceReference: "https://example.com/video" })), DocumentValidationError);
    assert.throws(() => discoverDocument(db, validFields({ referenceType: "external_https_url", sourceReference: "knowledge-input/manual.pdf" })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

// =====================================================================
// Origem / licença -- representável sem hardcode do Velatrader; licença
// desconhecida nunca produz aprovação automática
// =====================================================================

test("discoverDocument: enums existentes representam as 5 combinações pedidas sem nenhum hardcode específico do Velatrader", () => {
  withTempDb((db) => {
    // 1. arquivo privado fornecido pelo usuário
    assert.doesNotThrow(() =>
      discoverDocument(db, validFields({ id: "doc-1", sha256: "1".repeat(64), origin: "personal_upload", ownershipLicense: "private_personal", referenceType: "local_relative_path" }))
    );
    // 2. vídeo público externo
    assert.doesNotThrow(() =>
      discoverDocument(
        db,
        validFields({
          id: "doc-2",
          sha256: "2".repeat(64),
          type: "video",
          origin: "external_reference",
          ownershipLicense: "third_party_licensed",
          referenceType: "external_https_url",
          sourceReference: "https://example.com/curso",
          pageCount: null,
          durationSeconds: 3600,
        })
      )
    );
    // 3. transcrição fornecida pelo usuário
    assert.doesNotThrow(() =>
      discoverDocument(db, validFields({ id: "doc-3", sha256: "3".repeat(64), type: "transcript", origin: "personal_upload", referenceType: "manual_reference", sourceReference: "Transcrição fornecida manualmente" }))
    );
    // 4. exportação privada autorizada
    assert.doesNotThrow(() =>
      discoverDocument(db, validFields({ id: "doc-4", sha256: "4".repeat(64), type: "course_export", origin: "platform_export", referenceType: "local_relative_path", sourceReference: "exports/curso.zip" }))
    );
    // 5. licença/direito ainda não determinado
    assert.doesNotThrow(() => discoverDocument(db, validFields({ id: "doc-5", sha256: "5".repeat(64), ownershipLicense: "unknown" })));
  });
});

test("discoverDocument + transitionDocument: ownershipLicense='unknown' NUNCA produz aprovação automática -- ainda exige a mesma transição explícita com ator/motivo de qualquer outro documento", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ ownershipLicense: "unknown" }), { now: () => 1000 });
    const doc = getDocument(db, "doc-1");
    assert.equal(doc.status, "discovered"); // nunca começa aprovado, licença desconhecida ou não
    // Sem aprovação explícita (approvedBy), a transição continua exigindo o mesmo -- nenhum atalho por causa da licença desconhecida
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "approved_for_research", actorType: "operator" }), DocumentValidationError);
    const approved = transitionDocument(db, "doc-1", {
      toStatus: "approved_for_research",
      actorType: "operator",
      approvedBy: "usuario",
      reason: "conteúdo validado manualmente apesar da licença desconhecida",
      now: () => 5000,
    });
    assert.equal(approved.status, "approved_for_research");
    assert.equal(approved.ownership_license, "unknown"); // licença permanece desconhecida -- aprovação não a "resolveu" magicamente
  });
});

// =====================================================================
// Política de integridade de conteúdo (hash + tamanho) -- nunca fictícia,
// opcional em discovered/cataloged/processing_pending, obrigatória a
// partir de processed/approved, registro só via operação atômica auditada
// (revisão focalizada desta rodada -- inclui a correção final de
// size_bytes, que antes era erroneamente NOT NULL)
// =====================================================================

test("discoverDocument: fonte externa descoberta SEM hash e SEM tamanho -- identidade da fonte (URL) e integridade de conteúdo são coisas distintas", () => {
  withTempDb((db) => {
    const doc = discoverDocument(
      db,
      validFields({ type: "video", referenceType: "external_https_url", sourceReference: "https://example.com/curso", sha256: null, sizeBytes: null, pageCount: null })
    );
    assert.equal(doc.sha256, null);
    assert.equal(doc.size_bytes, null);
    assert.equal(doc.status, "discovered");
  });
});

test("discoverDocument: dois materiais DISTINTOS, ambos sem integridade (sha256 e sizeBytes null), são permitidos simultaneamente", () => {
  withTempDb((db) => {
    assert.doesNotThrow(() => discoverDocument(db, validFields({ id: "doc-1", sha256: null, sizeBytes: null })));
    assert.doesNotThrow(() => discoverDocument(db, validFields({ id: "doc-2", sha256: null, sizeBytes: null })));
    assert.equal(listDocuments(db).length, 2);
  });
});

test("discoverDocument: hash SEM tamanho é sempre rejeitado -- integridade é uma unidade só, nunca um sem o outro", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ sha256: "a".repeat(64), sizeBytes: null })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: tamanho SEM hash é sempre rejeitado -- integridade é uma unidade só, nunca um sem o outro", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ sha256: null, sizeBytes: 1000 })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: tamanho negativo é rejeitado", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ sizeBytes: -1 })), DocumentValidationError);
    assert.equal(listDocuments(db).length, 0);
  });
});

test("discoverDocument: tamanho ZERO conhecido com hash real é aceito -- 0 é tamanho REAL comprovado, nunca confundido com 'ainda desconhecido' (isso é NULL)", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, validFields({ sha256: "b0".repeat(32), sizeBytes: 0 }));
    assert.equal(doc.size_bytes, 0);
    assert.equal(doc.sha256, "b0".repeat(32));
  });
});

test("discoverDocument: integridade completa válida (hash real + tamanho real positivo) é aceita", () => {
  withTempDb((db) => {
    const doc = discoverDocument(db, validFields({ sha256: "b1".repeat(32), sizeBytes: 999999 }));
    assert.equal(doc.sha256, "b1".repeat(32));
    assert.equal(doc.size_bytes, 999999);
  });
});

test("discoverDocument: dois documentos com o MESMO hash real continuam rejeitados (duplicidade só entre hashes reais)", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ id: "doc-1", sha256: "b".repeat(64) }));
    assert.throws(() => discoverDocument(db, validFields({ id: "doc-2", sha256: "b".repeat(64) })), DuplicateHashError);
    assert.equal(listDocuments(db).length, 1);
  });
});

test("discoverDocument: hash malformado (quando informado) continua rejeitado", () => {
  withTempDb((db) => {
    assert.throws(() => discoverDocument(db, validFields({ sha256: "A".repeat(64) })), DocumentValidationError); // maiúsculo
    assert.throws(() => discoverDocument(db, validFields({ sha256: "a".repeat(63) })), DocumentValidationError); // curto
    assert.throws(() => discoverDocument(db, validFields({ sha256: "z".repeat(64) })), DocumentValidationError); // fora de hex
    assert.equal(listDocuments(db).length, 0);
  });
});

test("transitionDocument: tentativa de 'processed' SEM integridade de conteúdo real falha", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "processed", actorType: "system" }), DocumentValidationError);
    assert.equal(getDocument(db, "doc-1").status, "processing_pending"); // nada mudou
  });
});

test("transitionDocument: tentativa de 'approved_for_research' SEM integridade de conteúdo real falha, mesmo com approvedBy e reason presentes", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(
      () => transitionDocument(db, "doc-1", { toStatus: "approved_for_research", actorType: "operator", approvedBy: "usuario", reason: "revisado" }),
      DocumentValidationError
    );
    assert.equal(getDocument(db, "doc-1").status, "review_required"); // nada mudou
  });
});

test("registerContentIntegrity: registra hash + tamanho ATOMICAMENTE por operação explícita e auditada -- depois disso, a transição pra 'processed' passa a funcionar", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });

    const withIntegrity = registerContentIntegrity(db, "doc-1", { sha256: "e".repeat(64), sizeBytes: 424242, actorType: "system", actorReference: "pdf-extractor", now: () => 3500 });
    assert.equal(withIntegrity.sha256, "e".repeat(64));
    assert.equal(withIntegrity.size_bytes, 424242);
    assert.equal(withIntegrity.status, "processing_pending"); // registerContentIntegrity nunca muda o status por si só
    assert.equal(withIntegrity.updated_at_ms, 3500);

    const events = listDocumentEvents(db, "doc-1");
    const integrityEvent = events[events.length - 1];
    assert.equal(integrityEvent.from_status, "processing_pending");
    assert.equal(integrityEvent.to_status, "processing_pending"); // sem mudança de status, mas evento AUDITÁVEL registrado mesmo assim
    assert.equal(integrityEvent.actor_reference, "pdf-extractor");
    assert.equal(integrityEvent.reason, "content_integrity_registered");

    const processed = transitionDocument(db, "doc-1", { toStatus: "processed", actorType: "system", now: () => 4000 });
    assert.equal(processed.status, "processed"); // agora funciona, porque a integridade real já está registrada
  });
});

test("registerContentIntegrity: nunca registra só hash deixando tamanho desconhecido, nem só tamanho deixando hash desconhecido", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    assert.throws(() => registerContentIntegrity(db, "doc-1", { sha256: "a".repeat(64), sizeBytes: undefined, actorType: "system" }), DocumentValidationError);
    assert.throws(() => registerContentIntegrity(db, "doc-1", { sha256: undefined, sizeBytes: 1000, actorType: "system" }), DocumentValidationError);
    const doc = getDocument(db, "doc-1");
    assert.equal(doc.sha256, null); // nenhuma tentativa parcial gravou nada
    assert.equal(doc.size_bytes, null);
  });
});

test("registerContentIntegrity: hash malformado, tamanho negativo, documento inexistente e actorType inválido são rejeitados", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    assert.throws(() => registerContentIntegrity(db, "doc-1", { sha256: "Z".repeat(64), sizeBytes: 1000, actorType: "system" }), DocumentValidationError);
    assert.throws(() => registerContentIntegrity(db, "doc-1", { sha256: "a".repeat(64), sizeBytes: -1, actorType: "system" }), DocumentValidationError);
    assert.throws(() => registerContentIntegrity(db, "nao-existe", { sha256: "a".repeat(64), sizeBytes: 1000, actorType: "system" }), DocumentNotFoundError);
    assert.throws(() => registerContentIntegrity(db, "doc-1", { sha256: "a".repeat(64), sizeBytes: 1000, actorType: "hacker" }), DocumentValidationError);
    const doc = getDocument(db, "doc-1");
    assert.equal(doc.sha256, null); // nenhuma das tentativas inválidas gravou nada
    assert.equal(doc.size_bytes, null);
  });
});

test("registerContentIntegrity: rejeita sobrescrita silenciosa -- documento que JÁ tem integridade nunca aceita registrar outra (nem repetir a mesma)", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: "a".repeat(64), sizeBytes: 1000 }), { now: () => 1000 }); // já nasce com integridade
    assert.throws(
      () => registerContentIntegrity(db, "doc-1", { sha256: "b".repeat(64), sizeBytes: 2000, actorType: "system" }),
      ContentIntegrityAlreadyRegisteredError
    ); // hash e tamanho diferentes
    assert.throws(
      () => registerContentIntegrity(db, "doc-1", { sha256: "a".repeat(64), sizeBytes: 1000, actorType: "system" }),
      ContentIntegrityAlreadyRegisteredError
    ); // até os MESMOS valores são rejeitados -- nunca um "no-op silencioso"
    const doc = getDocument(db, "doc-1");
    assert.equal(doc.sha256, "a".repeat(64)); // permanece o original, intocado
    assert.equal(doc.size_bytes, 1000);
  });
});

test("registerContentIntegrity: duplicidade contra o hash de OUTRO documento continua rejeitada (índice único parcial vale aqui também)", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ id: "doc-1", sha256: "b".repeat(64) }));
    discoverDocument(db, validFields({ id: "doc-2", sha256: null, sizeBytes: null }));
    assert.throws(() => registerContentIntegrity(db, "doc-2", { sha256: "b".repeat(64), sizeBytes: 1000, actorType: "system" }), DuplicateHashError);
  });
});

test("registerContentIntegrity: UPDATE (hash + tamanho) + evento na MESMA transação -- falha intermediária (evento inválido) reverte AMBOS", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ sha256: null, sizeBytes: null }), { now: () => 1000 });
    assert.throws(() =>
      registerContentIntegrity(db, "doc-1", {
        sha256: "a".repeat(64),
        sizeBytes: 1000,
        actorType: "system",
        actorReference: "x".repeat(81), // viola CHECK de knowledge_document_events (limite 80), não validado em JS antes da transação
        now: () => 2000,
      })
    );
    const after = getDocument(db, "doc-1");
    assert.equal(after.sha256, null); // rollback completo -- nem o hash...
    assert.equal(after.size_bytes, null); // ...nem o tamanho "vazaram", mesmo com o evento tendo falhado depois
    assert.equal(listDocumentEvents(db, "doc-1").length, 1); // só o evento de 'discovered', nenhum evento parcial de integridade
  });
});

// =====================================================================
// transitionDocument -- transições permitidas e proibidas
// =====================================================================

test("transitionDocument: sequência completa permitida até approved_for_research grava marcos de data corretamente", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "processed", actorType: "system", now: () => 4000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 5000 });
    const doc = transitionDocument(db, "doc-1", {
      toStatus: "approved_for_research",
      actorType: "operator",
      approvedBy: "usuario",
      reason: "conteúdo revisado e validado",
      now: () => 6000,
    });
    assert.equal(doc.status, "approved_for_research");
    assert.equal(doc.cataloged_at_ms, 2000);
    assert.equal(doc.processed_at_ms, 4000);
    assert.equal(doc.last_reviewed_at_ms, 5000);
    assert.equal(doc.approved_by, "usuario");
    assert.equal(doc.approved_at_ms, 6000);
    assert.equal(doc.approval_reason, "conteúdo revisado e validado");
    assert.equal(listDocumentEvents(db, "doc-1").length, 6); // discovered + 5 transições
  });
});

test("transitionDocument: transição proibida lança InvalidDocumentTransitionError e NÃO altera nada no banco", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "approved_for_research", actorType: "operator", approvedBy: "x" }));
    const doc = getDocument(db, "doc-1");
    assert.equal(doc.status, "discovered"); // nunca mudou
    assert.equal(listDocumentEvents(db, "doc-1").length, 1); // só o evento de criação, nenhum evento de transição rejeitada
  });
});

test("transitionDocument: 'rejected' sem reason falha; sem actorReference (identidade) também falha; com ambos grava approval_reason", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "rejected", actorType: "operator" }), DocumentValidationError); // sem reason nem actorReference
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "rejected", actorType: "operator", reason: "conteúdo desatualizado" }), DocumentValidationError); // reason presente, mas actorType='operator' sozinho não é identidade suficiente
    const doc = transitionDocument(db, "doc-1", { toStatus: "rejected", actorType: "operator", actorReference: "usuario", reason: "conteúdo desatualizado", now: () => 5000 });
    assert.equal(doc.status, "rejected");
    assert.equal(doc.approval_reason, "conteúdo desatualizado");
    const events = listDocumentEvents(db, "doc-1");
    assert.equal(events[events.length - 1].actor_reference, "usuario"); // identidade do ator gravada no evento auditável
  });
});

test("transitionDocument: 'approved_for_research' sem approvedBy falha", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "approved_for_research", actorType: "operator" }), DocumentValidationError);
  });
});

test("transitionDocument: 'approved_for_research' com approvedBy vazio ('') falha -- ator vazio nunca é aceito", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "approved_for_research", actorType: "operator", approvedBy: "" }), DocumentValidationError);
    assert.equal(getDocument(db, "doc-1").status, "review_required"); // nada mudou
  });
});

test("transitionDocument: 'rejected' com reason vazio ('') falha", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", now: () => 4000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "rejected", actorType: "operator", reason: "" }), DocumentValidationError);
    assert.equal(getDocument(db, "doc-1").status, "review_required"); // nada mudou
  });
});

test("transitionDocument: falha intermediária no INSERT do evento (violação de CHECK de knowledge_document_events) reverte TODA a transação -- o UPDATE do documento NUNCA fica parcialmente aplicado", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    // actorReference com 81 caracteres viola o CHECK de
    // knowledge_document_events (limite 80) mas NÃO é validado em JS antes
    // da transação (só actorType/reason/approvedBy são) -- então o UPDATE
    // de knowledge_documents roda primeiro dentro da MESMA transação e só
    // falha depois, no INSERT do evento. Se a transação não fosse atômica,
    // o documento ficaria em 'cataloged' com só 1 evento (o de discovered)
    // -- um estado inconsistente que este teste prova que NUNCA acontece.
    assert.throws(() =>
      transitionDocument(db, "doc-1", {
        toStatus: "cataloged",
        actorType: "operator",
        actorReference: "x".repeat(81),
        now: () => 2000,
      })
    );
    const after = getDocument(db, "doc-1");
    assert.equal(after.status, "discovered"); // rollback completo -- o UPDATE não "vazou" mesmo com o evento tendo falhado depois
    assert.equal(after.updated_at_ms, after.discovered_at_ms); // updated_at também não avançou
    const events = listDocumentEvents(db, "doc-1");
    assert.equal(events.length, 1); // só o evento original de 'discovered' -- nenhum evento parcial de 'cataloged' foi inserido
  });
});

test("transitionDocument: 'retired' é terminal -- transição a partir de retired sempre falha", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "retired", actorType: "operator", now: () => 2000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator" }));
  });
});

test("transitionDocument: documento inexistente -> DocumentNotFoundError", () => {
  withTempDb((db) => {
    assert.throws(() => transitionDocument(db, "nao-existe", { toStatus: "cataloged", actorType: "operator" }), DocumentNotFoundError);
  });
});

test("transitionDocument: actorType inválido é rejeitado", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    assert.throws(() => transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "hacker" }), DocumentValidationError);
  });
});

test("transitionDocument: errorCode sanitizado é gravado no documento e no evento quando presente", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields(), { now: () => 1000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "processing_pending", actorType: "system", now: () => 3000 });
    const doc = transitionDocument(db, "doc-1", { toStatus: "review_required", actorType: "system", errorCode: "PDF_EXTRACTION_FAILED", now: () => 4000 });
    assert.equal(doc.last_error_code, "PDF_EXTRACTION_FAILED");
    const events = listDocumentEvents(db, "doc-1");
    assert.equal(events[events.length - 1].error_code, "PDF_EXTRACTION_FAILED");
  });
});

// =====================================================================
// listDocuments / listDocumentEvents
// =====================================================================

test("listDocuments: filtra por status corretamente", () => {
  withTempDb((db) => {
    discoverDocument(db, validFields({ id: "doc-1", sha256: "1".repeat(64) }), { now: () => 1000 });
    discoverDocument(db, validFields({ id: "doc-2", sha256: "2".repeat(64) }), { now: () => 2000 });
    transitionDocument(db, "doc-1", { toStatus: "cataloged", actorType: "operator", now: () => 3000 });
    assert.equal(listDocuments(db, { status: "discovered" }).length, 1);
    assert.equal(listDocuments(db, { status: "cataloged" }).length, 1);
    assert.equal(listDocuments(db).length, 2);
  });
});

// =====================================================================
// Ausência de ingestão automática, rede, AgentRouter, estratégia, risco, ordens
// =====================================================================

test("nenhuma ingestão automática: o próprio arquivo pessoal nunca é lido -- os testes acima nunca passam um caminho real do PDF nem chamam fs.readFile/crypto sobre ele", () => {
  // Prova por construção: todo `sourceReference`/`sha256` usado nos testes
  // acima é um valor FIXO/sintético ("ManualDeTeste.pdf", "a".repeat(64),
  // etc.), nunca derivado de ler o arquivo real. Este teste confirma que o
  // módulo de produção não importa `fs` nem `crypto` pra ler arquivo algum.
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "documentStore.js"), "utf8");
  assert.ok(!src.includes('require("fs")'));
  assert.ok(!src.includes("require('fs')"));
  assert.ok(!src.includes('require("crypto")'));
  assert.ok(!src.includes("readFileSync"));
  assert.ok(!src.includes("ManualdoCriptotrader")); // nenhum hardcode do arquivo real
});

test("nenhuma dependência de rede real, AgentRouter, estratégia, risco ou execução de ordens nos módulos novos", () => {
  // Remove comentários de linha E de bloco ANTES de escanear --
  // documentStates.js legitimamente COMENTA que "approved_for_agentrouter"
  // ainda não existe, e documentStore.js agora legitimamente CITA "https"
  // em comentários/identificadores (reference_type='external_https_url',
  // reuso documentado de urlSafety.validateInitialUrl) -- nada disso é uso
  // real de rede e não deveria contar como falha. "http"/"https" saíram da
  // lista de termos proibidos (ficaram legítimos com a URL externa desta
  // rodada); a garantia real de "nenhuma rede" agora é feita por checagem
  // precisa de import/chamada abaixo, não por substring cega.
  const files = [
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "documentStore.js"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "documentStates.js"),
    path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "pathSafety.js"),
  ];
  const forbidden = ["axios", "agentrouter", "aigateway", "bybit", "risk", "tradelifecycle", "openposition", "closeposition"];
  for (const file of files) {
    const stripped = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const srcNoComments = stripped.toLowerCase();
    for (const term of forbidden) {
      assert.ok(!srcNoComments.includes(term), `${path.basename(file)} não deveria usar "${term}" fora de comentário`);
    }
    assert.ok(!/require\(\s*["']https?["']\s*\)/.test(srcNoComments), `${path.basename(file)} não deveria importar o módulo http/https nativo do Node`);
    assert.ok(!/require\(\s*["']dns["']\s*\)/.test(srcNoComments), `${path.basename(file)} não deveria importar dns diretamente -- resolução fica inteiramente em urlSafety.js, nunca chamada por este módulo`);
    assert.ok(!srcNoComments.includes("fetch("), `${path.basename(file)} não deveria chamar fetch()`);
    assert.ok(!srcNoComments.includes("xmlhttprequest"), `${path.basename(file)} não deveria usar XMLHttpRequest`);
  }
});

test("documentStore.js importa SÓ validateInitialUrl de urlSafety.js -- nunca validateHop/resolveAndValidateAddresses (que fazem resolução DNS)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "knowledgeDocuments", "documentStore.js"), "utf8");
  const importMatch = src.match(/const\s*\{([^}]+)\}\s*=\s*require\(["']\.\.\/collectors\/sources\/urlSafety["']\)/);
  assert.ok(importMatch, "deveria importar lib/collectors/sources/urlSafety explicitamente");
  const imported = importMatch[1].split(",").map((s) => s.trim());
  assert.deepEqual(imported, ["validateInitialUrl"]);
});

test("SQLite exclusivamente temporário nos testes -- só runMigrations/MIGRATIONS_DIR são importados de lib/infra/db, nunca openDb/DEFAULT_DB_PATH (que apontam pro banco real)", () => {
  // Verifica a linha de IMPORT em si (regex ancorada no require específico),
  // não uma busca de substring solta no arquivo inteiro -- evita que o
  // próprio texto desta asserção ("openDb(") se autoacuse na varredura,
  // mesmo problema já visto (e corrigido) no teste anterior.
  const src = fs.readFileSync(__filename, "utf8");
  const importMatch = src.match(/const\s*\{([^}]+)\}\s*=\s*require\(["']\.\.\/\.\.\/lib\/infra\/db["']\)/);
  assert.ok(importMatch, "deveria importar lib/infra/db explicitamente");
  const imported = importMatch[1].split(",").map((s) => s.trim());
  assert.deepEqual(imported.sort(), ["MIGRATIONS_DIR", "runMigrations"].sort());
  assert.ok(src.includes("mkdtempSync")); // confirma o padrão de temp dir realmente em uso
});

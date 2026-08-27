const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { runMigrations, MIGRATIONS_DIR } = require("../../lib/infra/db");

// Nunca abre data/market.db real -- sempre :memory:, nunca toca disco
// persistente nem rede.
function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function baseDocFields(overrides = {}) {
  return {
    id: "doc-1",
    research_object_id: null,
    type: "pdf",
    title: "Manual de teste",
    origin: "personal_upload",
    ownership_license: "private_personal",
    privacy_classification: "private_personal",
    reference_type: "local_relative_path",
    source_reference: "ManualDeTeste.pdf",
    sha256: "a".repeat(64),
    size_bytes: 12345,
    page_count: 10,
    duration_seconds: null,
    language: "pt-BR",
    version: 1,
    status: "discovered",
    discovered_at: "2026-08-27T00:00:00.000Z",
    discovered_at_ms: 1000,
    retention_policy: "indefinite_local_only",
    retention_days: null,
    updated_at: "2026-08-27T00:00:00.000Z",
    updated_at_ms: 1000,
    ...overrides,
  };
}

const DOC_COLUMNS = [
  "id", "research_object_id", "type", "title", "origin", "ownership_license", "privacy_classification",
  "reference_type", "source_reference", "source_reference_original", "sha256", "size_bytes", "page_count", "duration_seconds", "language", "version",
  "status", "discovered_at", "discovered_at_ms", "retention_policy", "retention_days", "updated_at", "updated_at_ms",
];

function insertDoc(db, fields) {
  const cols = Object.keys(fields);
  const placeholders = cols.map((c) => `@${c}`).join(", ");
  return db.prepare(`INSERT INTO knowledge_documents (${cols.join(", ")}) VALUES (${placeholders})`).run(fields);
}

test("banco vazio: migração cria as 3 tabelas novas", () => {
  const db = freshDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes("knowledge_documents"));
  assert.ok(tables.includes("knowledge_document_events"));
  assert.ok(tables.includes("knowledge_units"));
  db.close();
});

test("migração registrada em schema_migrations com a versão correta (0015)", () => {
  const db = freshDb();
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  assert.ok(versions.includes(15));
  db.close();
});

test("banco já migrado: rodar runMigrations de novo é idempotente, não duplica nem falha", () => {
  const db = freshDb();
  assert.doesNotThrow(() => runMigrations(db, MIGRATIONS_DIR));
  const count = db.prepare("SELECT COUNT(*) as n FROM schema_migrations WHERE version = 15").get().n;
  assert.equal(count, 1);
  db.close();
});

test("insere documento válido com sucesso (caminho feliz do schema)", () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertDoc(db, baseDocFields()));
  const row = db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get("doc-1");
  assert.equal(row.status, "discovered");
  assert.equal(row.sha256, "a".repeat(64));
  db.close();
});

test("constraint: status fora do enum é rejeitado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ status: "not_a_real_status" })), /CHECK/);
  db.close();
});

test("constraint: type fora do enum ('pdf'|'video'|'course_export'|'transcript') é rejeitado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ type: "audio" })), /CHECK/);
  db.close();
});

test("constraint: sha256 precisa ser exatamente 64 hex minúsculos QUANDO informado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ sha256: "A".repeat(64) })), /CHECK/); // maiúsculo rejeitado
  assert.throws(() => insertDoc(db, baseDocFields({ sha256: "a".repeat(63) })), /CHECK/); // curto demais
  assert.throws(() => insertDoc(db, baseDocFields({ sha256: "z".repeat(64) })), /CHECK/); // char fora de hex
  db.close();
});

test("constraint: sha256 e size_bytes podem ser AMBOS NULL -- fonte externa descoberta sem hash e sem tamanho (nenhum conteúdo obtido ainda)", () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ sha256: null, size_bytes: null })));
  const row = db.prepare("SELECT sha256, size_bytes, status FROM knowledge_documents WHERE id = ?").get("doc-1");
  assert.equal(row.sha256, null);
  assert.equal(row.size_bytes, null);
  assert.equal(row.status, "discovered");
  db.close();
});

test("constraint: dois materiais DISTINTOS sem integridade (sha256 e size_bytes NULL) convivem livremente -- nunca são 'duplicados' entre si", () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ id: "doc-sem-integridade-1", sha256: null, size_bytes: null })));
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ id: "doc-sem-integridade-2", sha256: null, size_bytes: null })));
  const count = db.prepare("SELECT COUNT(*) as n FROM knowledge_documents WHERE sha256 IS NULL AND size_bytes IS NULL").get().n;
  assert.equal(count, 2);
  db.close();
});

test("constraint: sha256 precisa ser exatamente 64 hex minúsculos QUANDO informado (já coberto acima) -- sha256 é ÚNICO (índice parcial), hash REAL duplicado é rejeitado", () => {
  const db = freshDb();
  insertDoc(db, baseDocFields({ id: "doc-1", sha256: "b".repeat(64) }));
  assert.throws(() => insertDoc(db, baseDocFields({ id: "doc-2", sha256: "b".repeat(64) })), /UNIQUE/);
  db.close();
});

test("constraint: hash SEM tamanho (sha256 presente, size_bytes NULL) é sempre rejeitado -- integridade é uma unidade só", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ sha256: "a".repeat(64), size_bytes: null })), /CHECK/);
  db.close();
});

test("constraint: tamanho SEM hash (size_bytes presente, sha256 NULL) é sempre rejeitado -- integridade é uma unidade só", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ sha256: null, size_bytes: 12345 })), /CHECK/);
  db.close();
});

test("constraint: tamanho negativo é rejeitado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ size_bytes: -1 })), /CHECK/);
  db.close();
});

test("constraint: tamanho ZERO conhecido com hash real é aceito -- 0 é um tamanho REAL comprovado, nunca confundido com 'desconhecido' (isso é NULL)", () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ sha256: "b0".repeat(32), size_bytes: 0 })));
  const row = db.prepare("SELECT size_bytes FROM knowledge_documents WHERE id = ?").get("doc-1");
  assert.equal(row.size_bytes, 0);
  db.close();
});

test("constraint: integridade completa válida (hash real + tamanho real positivo) é aceita", () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ sha256: "b1".repeat(32), size_bytes: 999999 })));
  db.close();
});

test("constraint: 'processed' exige integridade completa (sha256 E size_bytes não-nulos) -- ambos NULL falha mesmo com o resto do status coerente", () => {
  const db = freshDb();
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          status: "processed",
          sha256: null,
          size_bytes: null,
          cataloged_at: "2026-08-27T00:00:00.000Z",
          cataloged_at_ms: 1000,
          processed_at: "2026-08-27T00:00:00.000Z",
          processed_at_ms: 1000,
        })
      ),
    /CHECK/
  );
  assert.doesNotThrow(() =>
    insertDoc(
      db,
      baseDocFields({
        id: "doc-processed-ok",
        sha256: "c1".repeat(32),
        size_bytes: 54321,
        status: "processed",
        cataloged_at: "2026-08-27T00:00:00.000Z",
        cataloged_at_ms: 1000,
        processed_at: "2026-08-27T00:00:00.000Z",
        processed_at_ms: 1000,
      })
    )
  );
  db.close();
});

test("constraint: page_count e duration_seconds nunca ambos preenchidos", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ page_count: 10, duration_seconds: 60 })), /CHECK/);
  db.close();
});

test("constraint: source_reference absoluto ou com travessia de diretório é rejeitado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ source_reference: "C:\\Users\\Universo\\manual.pdf" })), /CHECK/);
  assert.throws(() => insertDoc(db, baseDocFields({ source_reference: "/etc/passwd" })), /CHECK/);
  assert.throws(() => insertDoc(db, baseDocFields({ source_reference: "../../etc/passwd" })), /CHECK/);
  db.close();
});

test("constraint: reference_type fora do enum é rejeitado", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ reference_type: "url" })), /CHECK/);
  db.close();
});

test("constraint: reference_type='local_relative_path' -- lista completa de padrões proibidos é rejeitada, padrões seguros são aceitos", () => {
  const db = freshDb();
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
      () => insertDoc(db, baseDocFields({ id: `doc-forbidden-${i}`, sha256: `${i}`.repeat(64), source_reference: sourceReference })),
      /CHECK/,
      `"${sourceReference}" deveria ser rejeitado`
    );
  });
  const allowed = ["ManualdoCriptotrader2.0.pdf", "knowledge-input/velatrader/manual.pdf"];
  allowed.forEach((sourceReference, i) => {
    assert.doesNotThrow(
      () => insertDoc(db, baseDocFields({ id: `doc-allowed-${i}`, sha256: `a${i}`.repeat(32), source_reference: sourceReference })),
      `"${sourceReference}" deveria ser aceito`
    );
  });
  db.close();
});

test("constraint: reference_type='external_https_url' -- só https, sem credenciais, sem fragmento; query string é preservada", () => {
  const db = freshDb();
  assert.doesNotThrow(() =>
    insertDoc(
      db,
      baseDocFields({
        id: "doc-url-1",
        sha256: "1".repeat(64),
        reference_type: "external_https_url",
        source_reference: "https://www.youtube.com/watch?v=thJBGfbQKcg&t=15s",
      })
    )
  );
  const row = db.prepare("SELECT source_reference FROM knowledge_documents WHERE id = ?").get("doc-url-1");
  assert.equal(row.source_reference, "https://www.youtube.com/watch?v=thJBGfbQKcg&t=15s"); // query preservada, não é tratada como fragmento

  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-url-2", sha256: "2".repeat(64), reference_type: "external_https_url", source_reference: "http://example.com/video" })),
    /CHECK/ // esquema não-HTTPS
  );
  assert.throws(
    () =>
      insertDoc(db, baseDocFields({ id: "doc-url-3", sha256: "3".repeat(64), reference_type: "external_https_url", source_reference: "https://user:pass@example.com/video" })),
    /CHECK/ // credenciais embutidas
  );
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-url-4", sha256: "4".repeat(64), reference_type: "external_https_url", source_reference: "https://example.com/video#section" })),
    /CHECK/ // fragmento não é permitido na forma canônica
  );
  db.close();
});

test("constraint: reference_type='manual_reference' -- texto livre é aceito, caminho/URL disfarçado de manual_reference é rejeitado", () => {
  const db = freshDb();
  assert.doesNotThrow(() =>
    insertDoc(db, baseDocFields({ id: "doc-manual-1", sha256: "5".repeat(64), reference_type: "manual_reference", source_reference: "Legenda será fornecida manualmente pelo usuário" }))
  );
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-manual-2", sha256: "6".repeat(64), reference_type: "manual_reference", source_reference: "C:\\Users\\Nome\\arquivo.pdf" })),
    /CHECK/
  );
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-manual-3", sha256: "7".repeat(64), reference_type: "manual_reference", source_reference: "https://example.com/video" })),
    /CHECK/
  );
  db.close();
});

test("constraint (SQL): reference_type='manual_reference' -- '/' no MEIO da string também é rejeitado (diferente de local_relative_path)", () => {
  const db = freshDb();
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-manual-4", sha256: "f1".repeat(32), reference_type: "manual_reference", source_reference: "pasta/manual.pdf" })),
    /CHECK/
  );
  db.close();
});

test("constraint: coerência -- reference_type e source_reference nunca podem ser interpretados um como o outro (mismatch é sempre rejeitado)", () => {
  const db = freshDb();
  // URL rotulada como caminho local -- '://' é proibido em local_relative_path
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-mismatch-1", sha256: "8".repeat(64), reference_type: "local_relative_path", source_reference: "https://example.com/video" })),
    /CHECK/
  );
  // Caminho local rotulado como URL -- não começa com 'https://'
  assert.throws(
    () => insertDoc(db, baseDocFields({ id: "doc-mismatch-2", sha256: "9".repeat(64), reference_type: "external_https_url", source_reference: "knowledge-input/manual.pdf" })),
    /CHECK/
  );
  db.close();
});

test("constraint: source_reference_original só pode ser preenchido quando reference_type='external_https_url'", () => {
  const db = freshDb();
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          id: "doc-orig-mismatch",
          sha256: "d".repeat(64),
          reference_type: "local_relative_path",
          source_reference: "manual.pdf",
          source_reference_original: "https://example.com/video#section",
        })
      ),
    /CHECK/
  );
  assert.doesNotThrow(() =>
    insertDoc(
      db,
      baseDocFields({
        id: "doc-orig-ok",
        sha256: "e".repeat(64),
        reference_type: "external_https_url",
        source_reference: "https://example.com/video",
        source_reference_original: "https://example.com/video#section",
      })
    )
  );
  db.close();
});

test("constraint (SQL): source_reference_original -- defesa estrutural complementar rejeita credenciais, esquema não-HTTPS e CR/LF diretamente na camada de banco", () => {
  // Nota: este CHECK é defesa ESTRUTURAL complementar (esquema/tamanho/
  // controle/credenciais óbvias em texto), NUNCA validação SSRF completa --
  // a validação semântica real (DNS, IP, porta, localhost) é
  // responsabilidade exclusiva de urlSafety.js::validateInitialUrl, chamada
  // pela camada de aplicação sobre a URL ORIGINAL antes da canonicalização.
  const db = freshDb();
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          id: "doc-orig-creds",
          sha256: "10".repeat(32),
          reference_type: "external_https_url",
          source_reference: "https://example.com/video",
          source_reference_original: "https://user:pass@example.com/video#section",
        })
      ),
    /CHECK/
  );
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          id: "doc-orig-http",
          sha256: "11".repeat(32),
          reference_type: "external_https_url",
          source_reference: "https://example.com/video",
          source_reference_original: "http://example.com/video",
        })
      ),
    /CHECK/
  );
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          id: "doc-orig-crlf",
          sha256: "12".repeat(32),
          reference_type: "external_https_url",
          source_reference: "https://example.com/video",
          source_reference_original: "https://example.com/video\r\n#section",
        })
      ),
    /CHECK/
  );
  db.close();
});

test("constraint (SQL): knowledge_document_events -- 'rejected' exige actor_reference E reason não-nulos (actor_type sozinho não é identidade suficiente)", () => {
  const db = freshDb();
  insertDoc(db, baseDocFields());
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO knowledge_document_events (document_id, from_status, to_status, actor_type, actor_reference, reason, occurred_at, occurred_at_ms)
           VALUES ('doc-1', 'review_required', 'rejected', 'operator', NULL, 'motivo qualquer', '2026-08-27T00:00:00.000Z', 1000)`
        )
        .run(),
    /CHECK/
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO knowledge_document_events (document_id, from_status, to_status, actor_type, actor_reference, reason, occurred_at, occurred_at_ms)
           VALUES ('doc-1', 'review_required', 'rejected', 'operator', 'usuario', NULL, '2026-08-27T00:00:00.000Z', 1000)`
        )
        .run(),
    /CHECK/
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO knowledge_document_events (document_id, from_status, to_status, actor_type, actor_reference, reason, occurred_at, occurred_at_ms)
         VALUES ('doc-1', 'review_required', 'rejected', 'operator', 'usuario', 'motivo qualquer', '2026-08-27T00:00:00.000Z', 1000)`
      )
      .run()
  );
  db.close();
});

test("constraint: research_object_id precisa ser kebab-case quando presente", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ research_object_id: "Not Kebab Case!" })), /CHECK/);
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ research_object_id: "feature-manual-x" })));
  db.close();
});

test("constraint: coerência status <-> campos -- 'approved_for_research' exige approved_by e approved_at", () => {
  const db = freshDb();
  assert.throws(
    () => insertDoc(db, baseDocFields({ status: "approved_for_research", cataloged_at: "2026-08-27T00:00:00.000Z", cataloged_at_ms: 1000 })),
    /CHECK/
  );
  db.close();
});

test("constraint: 'approved_for_research' TAMBÉM exige approval_reason não-nulo -- mesmo com approved_by/approved_at presentes", () => {
  const db = freshDb();
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          status: "approved_for_research",
          cataloged_at: "2026-08-27T00:00:00.000Z",
          cataloged_at_ms: 1000,
          approved_by: "usuario",
          approved_at: "2026-08-27T00:00:00.000Z",
          approved_at_ms: 1000,
          approval_reason: null,
        })
      ),
    /CHECK/
  );
  db.close();
});

test("constraint: 'approved_for_research' TAMBÉM exige integridade completa (sha256 E size_bytes não-nulos) -- mesmo com todos os outros campos de aprovação presentes", () => {
  const db = freshDb();
  assert.throws(
    () =>
      insertDoc(
        db,
        baseDocFields({
          status: "approved_for_research",
          sha256: null,
          size_bytes: null,
          cataloged_at: "2026-08-27T00:00:00.000Z",
          cataloged_at_ms: 1000,
          approved_by: "usuario",
          approved_at: "2026-08-27T00:00:00.000Z",
          approved_at_ms: 1000,
          approval_reason: "conteúdo validado",
        })
      ),
    /CHECK/
  );
  assert.doesNotThrow(() =>
    insertDoc(
      db,
      baseDocFields({
        id: "doc-approved-ok",
        sha256: "d1".repeat(32),
        size_bytes: 77777,
        status: "approved_for_research",
        cataloged_at: "2026-08-27T00:00:00.000Z",
        cataloged_at_ms: 1000,
        approved_by: "usuario",
        approved_at: "2026-08-27T00:00:00.000Z",
        approved_at_ms: 1000,
        approval_reason: "conteúdo validado",
      })
    )
  );
  db.close();
});

test("constraint: 'rejected' exige approval_reason preenchido", () => {
  const db = freshDb();
  assert.throws(
    () => insertDoc(db, baseDocFields({ status: "rejected", cataloged_at: "2026-08-27T00:00:00.000Z", cataloged_at_ms: 1000 })),
    /CHECK/
  );
  db.close();
});

test("constraint: retention_policy='delete_after_days' exige retention_days > 0", () => {
  const db = freshDb();
  assert.throws(() => insertDoc(db, baseDocFields({ retention_policy: "delete_after_days", retention_days: null })), /CHECK/);
  assert.doesNotThrow(() => insertDoc(db, baseDocFields({ retention_policy: "delete_after_days", retention_days: 30 })));
  db.close();
});

test("knowledge_document_events: FOREIGN KEY exige document_id existente quando foreign_keys=ON", () => {
  const db = freshDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO knowledge_document_events (document_id, from_status, to_status, actor_type, occurred_at, occurred_at_ms)
           VALUES ('nao-existe', NULL, 'discovered', 'system', '2026-08-27T00:00:00.000Z', 1000)`
        )
        .run(),
    /FOREIGN KEY/
  );
  db.close();
});

test("knowledge_units: own_summary nunca pode exceder 2000 caracteres (teto estrutural contra armazenar conteúdo integral)", () => {
  const db = freshDb();
  insertDoc(db, baseDocFields());
  const insertUnit = (summary) =>
    db
      .prepare(
        `INSERT INTO knowledge_units (id, document_id, locator_kind, locator_value, hash, own_summary, review_status, created_at, created_at_ms, updated_at, updated_at_ms)
         VALUES ('unit-1', 'doc-1', 'page', '1', @hash, @summary, 'pending_review', '2026-08-27T00:00:00.000Z', 1000, '2026-08-27T00:00:00.000Z', 1000)`
      )
      .run({ hash: "c".repeat(64), summary });
  assert.throws(() => insertUnit("x".repeat(2001)), /CHECK/);
  assert.doesNotThrow(() => insertUnit("x".repeat(2000)));
  db.close();
});

test("índices esperados existem", () => {
  const db = freshDb();
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  assert.ok(indexes.includes("idx_knowledge_documents_status"));
  assert.ok(indexes.includes("idx_knowledge_documents_type"));
  assert.ok(indexes.includes("idx_knowledge_documents_research_object_id"));
  assert.ok(indexes.includes("idx_knowledge_documents_sha256"));
  assert.ok(indexes.includes("idx_knowledge_document_events_document_id"));
  assert.ok(indexes.includes("idx_knowledge_units_document_id"));
  db.close();
});

module.exports = { baseDocFields, insertDoc, freshDb };

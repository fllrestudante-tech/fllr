-- Base de Conhecimento Velatrader -- Commit 1 (estrutural). Catálogo de
-- materiais educacionais privados (PDF/vídeo/export de plataforma/
-- transcrição) com proveniência, integridade, estado de processamento e
-- aprovação humana. NENHUM conteúdo integral é armazenado aqui -- só
-- metadados, hash e (no futuro, tabela knowledge_units) resumos curtos
-- próprios, nunca o texto/vídeo original.
--
-- FONTE ÚNICA DE VERDADE -- decisão explícita: lib/registry/ (Feature
-- Registry) é um JSON curado à mão e VERSIONADO NO GIT
-- (registry/research-objects.json, ver lib/registry/registryStore.js:1-4)
-- -- certo para metadados estáveis, de baixo volume, editados por humano
-- (Features/Brains/Experiments). Documentos privados descobertos em disco,
-- com estado que muda em runtime (discovered->cataloged->...->retired) e
-- hash calculado automaticamente, são o oposto disso -- não pertencem a um
-- arquivo versionado em Git (o PDF em si já é pessoal e nunca entra no
-- Git; nem seus metadados de estado operacional deveriam). Este banco
-- SQLite (data/market.db, já compartilhado por todo o resto do projeto) é
-- a ÚNICA fonte de verdade sobre identidade/estado/hash/aprovação de cada
-- documento. `research_object_id` é um vínculo OPCIONAL, só quando um
-- humano deliberadamente decide que um documento embasa um Research Object
-- já catalogado (ex.: "este manual sustenta a hipótese feature-x") -- o
-- Registry nunca duplica linha de documento, só referencia o id pelo
-- campo. Sem FOREIGN KEY de verdade (o Registry não é uma tabela SQL) --
-- só formato validado por CHECK aqui e por lib/registry/researchObject.js::ID_PATTERN
-- no lado da aplicação.
--
-- Nenhuma coluna aceita conteúdo integral, segredo, credencial ou caminho
-- absoluto/pessoal -- source_reference é validado conforme o discriminador
-- reference_type (ver CHECK abaixo e lib/knowledgeDocuments/pathSafety.js
-- e lib/collectors/sources/urlSafety.js).
--
-- ROLLBACK -- esta migration é puramente aditiva (só CREATE TABLE/INDEX).
-- `git revert` deste commit remove o ARQUIVO de migration do repositório,
-- mas NÃO desfaz automaticamente o schema num banco onde ela já rodou --
-- runMigrations() nunca executa "down"/DROP. Rollback operacional real
-- significa: (1) parar de usar o recurso (nenhum código novo referencia
-- estas tabelas fora deste commit), preservando tabelas e dados intactos;
-- (2) restaurar de um backup do banco, só se estritamente necessário; ou
-- (3) escrever e autorizar explicitamente uma migration futura que faça
-- DROP/ALTER -- nunca algo implícito ou automático a partir de um revert
-- de código.

CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 64 AND instr(id, char(10)) = 0 AND instr(id, char(13)) = 0 AND instr(id, char(0)) = 0),

  -- Vínculo OPCIONAL com um Research Object do Registry (JSON, fora deste
  -- banco) -- só formato validado aqui (mesmo padrão kebab-case de
  -- lib/registry/researchObject.js::ID_PATTERN); existência real é
  -- responsabilidade da camada de aplicação, nunca uma FOREIGN KEY (o
  -- Registry não é SQL).
  research_object_id TEXT
    CHECK(research_object_id IS NULL OR (
      length(research_object_id) BETWEEN 1 AND 80
      AND research_object_id NOT GLOB '*[^a-z0-9-]*'
      AND substr(research_object_id, 1, 1) != '-'
      AND substr(research_object_id, -1, 1) != '-'
    )),

  type TEXT NOT NULL CHECK(type IN ('pdf', 'video', 'course_export', 'transcript')),

  title TEXT NOT NULL
    CHECK(length(title) BETWEEN 1 AND 300 AND instr(title, char(10)) = 0 AND instr(title, char(13)) = 0 AND instr(title, char(0)) = 0),

  origin TEXT NOT NULL CHECK(origin IN ('personal_upload', 'external_reference', 'platform_export')),

  ownership_license TEXT NOT NULL CHECK(ownership_license IN ('private_personal', 'user_created', 'third_party_licensed', 'unknown')),

  privacy_classification TEXT NOT NULL CHECK(privacy_classification IN ('private_personal', 'private_sensitive', 'internal_only', 'shareable')),

  -- Discriminador EXPLÍCITO do que `source_reference` contém -- nunca
  -- "adivinhamos" se uma string é caminho local, URL externa ou texto
  -- livre: quem grava declara o tipo, e cada tipo tem sua própria
  -- gramática validada abaixo. Um valor incompatível com o tipo declarado
  -- é rejeitado, nunca reinterpretado silenciosamente como outro formato.
  reference_type TEXT NOT NULL CHECK(reference_type IN ('local_relative_path', 'external_https_url', 'manual_reference')),

  -- Significado condicionado por `reference_type`:
  --   local_relative_path -- caminho relativo à raiz do projeto: nunca
  --     absoluto, nunca letra de unidade, nunca UNC (\\servidor\...) nem
  --     device path (\\?\...), nunca travessia ('..'), nunca esquema de
  --     URL (nenhum '://'), nunca contém '\' (separador canônico é '/' --
  --     normalização de \ pra / acontece em
  --     lib/knowledgeDocuments/pathSafety.js ANTES de chegar aqui). O
  --     arquivo original em si continua fora do Git sempre.
  --   external_https_url -- URL pública, só HTTPS, já validada
  --     estruturalmente por lib/collectors/sources/urlSafety.js::validateInitialUrl
  --     (mesma proteção contra SSRF do resto do projeto -- sem DNS e sem
  --     requisição HTTP nesta camada, nem na camada de aplicação deste
  --     commit). Forma CANÔNICA: sem fragmento (#...), mas com a query
  --     string preservada tal como recebida (ex.: "?v=xxx&t=15s" nunca é
  --     removido como se fosse fragmento -- só '#...' é). Nunca contém
  --     credenciais embutidas (usuário:senha), localhost, IP não-público
  --     ou porta fora da allowlist -- rejeitado antes de chegar ao INSERT.
  --   manual_reference -- texto curto livre descrevendo uma fonte que
  --     ainda não tem caminho local nem URL definidos (ex.: "transcrição
  --     será fornecida manualmente pelo usuário") -- rejeitado se parecer
  --     caminho ou URL (mesma gramática proibida de local_relative_path),
  --     pra impedir que alguém rotule um caminho/URL real como
  --     "manual_reference" só pra escapar da validação do tipo certo.
  source_reference TEXT NOT NULL
    CHECK(
      length(source_reference) BETWEEN 1 AND 500
      AND instr(source_reference, char(10)) = 0
      AND instr(source_reference, char(13)) = 0
      AND instr(source_reference, char(0)) = 0
      AND (
        reference_type != 'local_relative_path' OR (
          instr(source_reference, '..') = 0
          AND substr(source_reference, 1, 1) != '/'
          AND instr(source_reference, '\') = 0
          AND source_reference NOT GLOB '?:*'
          AND instr(source_reference, '://') = 0
        )
      )
      AND (
        reference_type != 'external_https_url' OR (
          substr(source_reference, 1, 8) = 'https://'
          AND instr(source_reference, '@') = 0
          AND instr(source_reference, '#') = 0
        )
      )
      AND (
        -- manual_reference é SÓ descrição curta de pendência, nunca um
        -- fragmento de caminho -- diferente de local_relative_path, aqui
        -- '/' é proibido em QUALQUER posição (não só no início), pois
        -- local_relative_path é quem legitimamente usa '/' como separador
        -- de subpasta. A forma "parece nome de arquivo isolado" (token sem
        -- espaço terminado em extensão, ex. "manual.pdf") não é
        -- verificável de forma robusta em CHECK puro -- fica a cargo da
        -- camada de aplicação (lib/knowledgeDocuments/pathSafety.js::isSafeManualReference),
        -- que é a validação AUTORITATIVA; este CHECK é só defesa
        -- estrutural complementar pros casos claramente estruturais
        -- (separador, esquema, letra de unidade, travessia).
        reference_type != 'manual_reference' OR (
          instr(source_reference, '..') = 0
          AND instr(source_reference, '/') = 0
          AND instr(source_reference, '\') = 0
          AND source_reference NOT GLOB '?:*'
          AND instr(source_reference, '://') = 0
        )
      )
    ),

  -- Só preenchido quando reference_type = 'external_https_url' E a URL
  -- recebida originalmente diferia da forma canônica acima (hoje isso só
  -- acontece quando havia fragmento '#...', que a canônica sempre remove
  -- -- query string idêntica na origem e na canônica deixa este campo
  -- NULL, não duplica). Preservado só pra auditoria de proveniência --
  -- nunca é o que o resto do sistema usa como identidade (isso é sempre
  -- `source_reference`).
  --
  -- Este CHECK é DEFESA ESTRUTURAL COMPLEMENTAR (esquema/tamanho/controle/
  -- credenciais óbvias em texto) -- NÃO é validação SSRF completa (não
  -- resolve DNS, não classifica IP, não bloqueia localhost/porta/IP
  -- privado). A validação semântica real acontece em
  -- lib/collectors/sources/urlSafety.js::validateInitialUrl, chamada pela
  -- camada de aplicação (lib/knowledgeDocuments/documentStore.js) sobre a
  -- URL ORIGINAL, ANTES da canonicalização -- nunca só sobre a forma
  -- canônica.
  source_reference_original TEXT
    CHECK(
      source_reference_original IS NULL OR (
        length(source_reference_original) BETWEEN 1 AND 500
        AND instr(source_reference_original, char(10)) = 0
        AND instr(source_reference_original, char(13)) = 0
        AND instr(source_reference_original, char(0)) = 0
        AND substr(source_reference_original, 1, 8) = 'https://'
        AND instr(source_reference_original, '@') = 0
      )
    ),

  -- Hash de CONTEÚDO real, nunca da identidade/referência da fonte --
  -- distinção deliberada: um documento pode ser DESCOBERTO (URL/caminho já
  -- conhecidos) sem que nenhum conteúdo tenha sido obtido ainda, então
  -- NULL é permitido enquanto isso for verdade (`discovered`/`cataloged`,
  -- ver CHECK de tabela abaixo que exige hash não-nulo a partir de
  -- 'processed'). NUNCA um hash sintético, placeholder ou derivado da
  -- própria URL/caminho pode ser gravado aqui como se fosse hash de
  -- conteúdo -- quando presente, continua sendo exatamente 64 hex
  -- minúsculos. Unicidade fica em ÍNDICE PARCIAL abaixo (`WHERE sha256 IS
  -- NOT NULL`, mesmo padrão de idx_system_incidents_open na migração 0007)
  -- -- múltiplos documentos sem hash (NULL) são permitidos simultaneamente;
  -- só hashes REAIS (não-nulos) competem por unicidade entre si. Se no
  -- futuro existirem artefatos distintos do mesmo documento (vídeo, áudio,
  -- legenda, transcrição), cada um terá sua PRÓPRIA linha/identidade e seu
  -- PRÓPRIO hash -- nenhum hash aqui nunca representa por procuração o
  -- conteúdo de outro artefato.
  sha256 TEXT
    CHECK(sha256 IS NULL OR (length(sha256) = 64 AND sha256 = lower(sha256) AND sha256 NOT GLOB '*[^0-9a-f]*')),

  -- Tamanho REAL do conteúdo -- mesma distinção deliberada de sha256:
  -- NULL = ainda desconhecido (nenhum conteúdo obtido), 0 = conhecido e
  -- COMPROVADAMENTE vazio (um artefato real de tamanho zero -- caso raro
  -- mas legítimo, distinto de "não sei"), positivo = tamanho real
  -- conhecido. NUNCA 0 ou qualquer valor fictício representa "desconhecido"
  -- -- só NULL representa isso. Ver CHECK de tabela abaixo que exige
  -- sha256 e size_bytes SEMPRE juntos (ambos NULL ou ambos presentes).
  size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0),

  -- Nunca ambos ao mesmo tempo -- página é conceito de documento, duração
  -- é conceito de vídeo, um material é um ou outro, nunca os dois.
  page_count INTEGER CHECK(page_count IS NULL OR page_count > 0),
  duration_seconds INTEGER CHECK(duration_seconds IS NULL OR duration_seconds > 0),

  language TEXT
    CHECK(language IS NULL OR (length(language) BETWEEN 2 AND 10 AND instr(language, char(10)) = 0 AND instr(language, char(13)) = 0 AND instr(language, char(0)) = 0)),

  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),

  status TEXT NOT NULL CHECK(status IN (
    'discovered', 'cataloged', 'processing_pending', 'processed',
    'review_required', 'approved_for_research', 'rejected', 'suspended', 'retired'
  )),

  discovered_at TEXT NOT NULL,
  discovered_at_ms INTEGER NOT NULL CHECK(discovered_at_ms >= 0),
  cataloged_at TEXT,
  cataloged_at_ms INTEGER CHECK(cataloged_at_ms IS NULL OR cataloged_at_ms >= discovered_at_ms),
  processed_at TEXT,
  processed_at_ms INTEGER CHECK(processed_at_ms IS NULL OR processed_at_ms >= discovered_at_ms),
  last_reviewed_at TEXT,
  last_reviewed_at_ms INTEGER CHECK(last_reviewed_at_ms IS NULL OR last_reviewed_at_ms >= discovered_at_ms),

  -- Nunca a mensagem de erro real -- só um código curto sanitizado (mesma
  -- disciplina de errorCode já usada em todo o resto do projeto, ver
  -- lib/aiGateway/agentRouterGate.js).
  last_error_code TEXT
    CHECK(last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 60 AND instr(last_error_code, char(10)) = 0 AND instr(last_error_code, char(13)) = 0 AND instr(last_error_code, char(0)) = 0)),

  retention_policy TEXT NOT NULL CHECK(retention_policy IN ('indefinite_local_only', 'delete_after_review', 'delete_after_days')),
  retention_days INTEGER CHECK(retention_days IS NULL OR retention_days > 0),

  approved_by TEXT
    CHECK(approved_by IS NULL OR (length(approved_by) BETWEEN 1 AND 80 AND instr(approved_by, char(10)) = 0 AND instr(approved_by, char(13)) = 0 AND instr(approved_by, char(0)) = 0)),
  approved_at TEXT,
  approved_at_ms INTEGER CHECK(approved_at_ms IS NULL OR approved_at_ms >= discovered_at_ms),
  approval_reason TEXT
    CHECK(approval_reason IS NULL OR (length(approval_reason) BETWEEN 1 AND 300 AND instr(approval_reason, char(10)) = 0 AND instr(approval_reason, char(13)) = 0 AND instr(approval_reason, char(0)) = 0)),

  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= discovered_at_ms),

  -- Constraints de nível de TABELA (multi-coluna) -- SEMPRE depois de
  -- todas as definições de coluna, nunca intercaladas: a gramática do
  -- SQLite não permite voltar a declarar coluna depois do primeiro
  -- table-constraint (mesmo padrão já seguido em agentrouter_budget_ledger,
  -- migração 0014).
  CHECK(page_count IS NULL OR duration_seconds IS NULL),
  CHECK(status = 'discovered' OR cataloged_at IS NOT NULL),
  -- Aprovação exige TUDO simultaneamente: responsável humano, data, motivo
  -- não vazio E integridade de conteúdo real (hash E tamanho) -- nenhum
  -- atalho, nenhuma aprovação "provisória" sem os cinco.
  CHECK(status != 'approved_for_research' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL AND approval_reason IS NOT NULL AND sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  CHECK(status != 'rejected' OR approval_reason IS NOT NULL),
  CHECK(retention_policy != 'delete_after_days' OR retention_days IS NOT NULL),
  CHECK(reference_type = 'external_https_url' OR source_reference_original IS NULL),
  -- Integridade de conteúdo real (hash E tamanho) é obrigatória a partir de
  -- 'processed' (nunca antes -- 'discovered'/'cataloged'/'processing_pending'
  -- seguem livremente sem integridade, é exatamente o período em que o
  -- conteúdo ainda não foi obtido). 'review_required'/'rejected'/
  -- 'suspended'/'retired' não exigem por si só (um material pode ser
  -- suspenso/rejeitado/retirado antes de qualquer conteúdo ter sido
  -- baixado) -- o gate real de 'approved_for_research' já está no CHECK
  -- acima.
  CHECK(status != 'processed' OR (sha256 IS NOT NULL AND size_bytes IS NOT NULL)),
  -- sha256 e size_bytes SEMPRE juntos: ambos NULL (nada obtido ainda) ou
  -- ambos presentes (integridade completa) -- nunca hash sem tamanho, nunca
  -- tamanho sem hash. `(x IS NULL) = (y IS NULL)` é uma comparação booleana
  -- válida em SQLite (IS NULL sempre devolve 0/1, nunca NULL).
  CHECK((sha256 IS NULL) = (size_bytes IS NULL))
);

CREATE INDEX idx_knowledge_documents_status ON knowledge_documents(status);
CREATE INDEX idx_knowledge_documents_type ON knowledge_documents(type);
CREATE INDEX idx_knowledge_documents_research_object_id ON knowledge_documents(research_object_id);
-- Índice ÚNICO PARCIAL -- só hashes REAIS (não-nulos) competem por
-- unicidade; múltiplos documentos ainda sem hash convivem livremente.
-- Mesmo padrão de idx_system_incidents_open (migração 0007).
CREATE UNIQUE INDEX idx_knowledge_documents_sha256 ON knowledge_documents(sha256) WHERE sha256 IS NOT NULL;

-- Trilha append-only de transições -- mesmo padrão de
-- agentrouter_budget_events (migração 0014): só INSERT, nunca
-- UPDATE/DELETE público, uma linha por transição de estado.
CREATE TABLE knowledge_document_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id),

  from_status TEXT CHECK(from_status IS NULL OR from_status IN (
    'discovered', 'cataloged', 'processing_pending', 'processed',
    'review_required', 'approved_for_research', 'rejected', 'suspended', 'retired'
  )),
  to_status TEXT NOT NULL CHECK(to_status IN (
    'discovered', 'cataloged', 'processing_pending', 'processed',
    'review_required', 'approved_for_research', 'rejected', 'suspended', 'retired'
  )),

  actor_type TEXT NOT NULL CHECK(actor_type IN ('system', 'operator')),
  actor_reference TEXT
    CHECK(actor_reference IS NULL OR (length(actor_reference) BETWEEN 1 AND 80 AND instr(actor_reference, char(10)) = 0 AND instr(actor_reference, char(13)) = 0 AND instr(actor_reference, char(0)) = 0)),

  reason TEXT
    CHECK(reason IS NULL OR (length(reason) BETWEEN 1 AND 300 AND instr(reason, char(10)) = 0 AND instr(reason, char(13)) = 0 AND instr(reason, char(0)) = 0)),
  error_code TEXT
    CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 60 AND instr(error_code, char(10)) = 0 AND instr(error_code, char(13)) = 0 AND instr(error_code, char(0)) = 0)),

  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),

  -- 'rejected' exige identidade do ator ALÉM do actor_type genérico
  -- ('operator' sozinho não identifica QUEM) -- actor_reference não pode
  -- ser NULL nesse evento, mesma exigência imposta em JS
  -- (documentStore.js::transitionDocument). motivo (reason) também
  -- obrigatório aqui, espelhando approval_reason NOT NULL já exigido em
  -- knowledge_documents pro status 'rejected'.
  CHECK(to_status != 'rejected' OR (actor_reference IS NOT NULL AND reason IS NOT NULL))
);

CREATE INDEX idx_knowledge_document_events_document_id ON knowledge_document_events(document_id, occurred_at_ms, id);

-- Unidades de conhecimento (página/capítulo/timestamp) -- schema mínimo
-- preparado agora, SEM nenhuma linha inserida nesta rodada e SEM nenhum
-- módulo JS que a alimente ainda (nada extrai conteúdo do PDF neste
-- commit). own_summary é limitado a 2000 caracteres -- reforça em nível de
-- schema que isto NUNCA guarda o texto integral do material original.
CREATE TABLE knowledge_units (
  id TEXT PRIMARY KEY
    CHECK(length(id) BETWEEN 1 AND 64 AND instr(id, char(10)) = 0 AND instr(id, char(13)) = 0 AND instr(id, char(0)) = 0),
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id),

  locator_kind TEXT NOT NULL CHECK(locator_kind IN ('page', 'chapter', 'timestamp', 'section')),
  locator_value TEXT NOT NULL
    CHECK(length(locator_value) BETWEEN 1 AND 40 AND instr(locator_value, char(10)) = 0 AND instr(locator_value, char(13)) = 0 AND instr(locator_value, char(0)) = 0),

  unit_type TEXT
    CHECK(unit_type IS NULL OR (length(unit_type) BETWEEN 1 AND 40 AND instr(unit_type, char(10)) = 0 AND instr(unit_type, char(13)) = 0 AND instr(unit_type, char(0)) = 0)),

  hash TEXT NOT NULL CHECK(length(hash) = 64 AND hash = lower(hash) AND hash NOT GLOB '*[^0-9a-f]*'),

  -- NUNCA o conteúdo integral -- teto estrutural de 2000 caracteres.
  own_summary TEXT CHECK(own_summary IS NULL OR length(own_summary) <= 2000),

  provenance TEXT
    CHECK(provenance IS NULL OR (length(provenance) BETWEEN 1 AND 300 AND instr(provenance, char(10)) = 0 AND instr(provenance, char(13)) = 0 AND instr(provenance, char(0)) = 0)),

  review_status TEXT NOT NULL DEFAULT 'pending_review' CHECK(review_status IN ('pending_review', 'reviewed_ok', 'reviewed_flagged')),
  human_decision TEXT
    CHECK(human_decision IS NULL OR (length(human_decision) BETWEEN 1 AND 200 AND instr(human_decision, char(10)) = 0 AND instr(human_decision, char(13)) = 0 AND instr(human_decision, char(0)) = 0)),

  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),

  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
);

CREATE INDEX idx_knowledge_units_document_id ON knowledge_units(document_id);

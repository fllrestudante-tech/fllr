// Garante que nenhum caminho pessoal (usuário do SO, letra de unidade,
// estrutura de pastas fora do projeto) apareça em source_reference gravado
// no banco, nem em qualquer log/erro derivado dele. Também valida
// `manual_reference` (texto livre que não pode se disfarçar de caminho nem
// de URL). Puro, sem I/O -- validação de URL fica em
// lib/collectors/sources/urlSafety.js, nunca reimplementada aqui.
const path = require("path");

// Rejeita: travessia ('..'), caminho absoluto Unix ('/...'), letra de
// unidade Windows ('C:...'), QUALQUER esquema de URL ('scheme://...' --
// cobre file://, http://, https://, etc.) e QUALQUER '\' na string (cobre
// caminho absoluto Windows, UNC '\\servidor\...' e device path '\\?\...'
// de uma vez só -- o separador canônico aceito é sempre '/', nunca '\';
// normalização de '\' pra '/' é feita ANTES de chegar aqui, em
// toSafeSourceReference). Usada só por local_relative_path -- '/' no meio
// da string é um separador de subpasta LEGÍTIMO aqui (ex.:
// "knowledge-input/manual.pdf"), diferente de manual_reference (que tem
// sua própria regra, mais estrita, abaixo).
const UNSAFE_LOCAL_PATH_RE = /\.\.|^\/|^[A-Za-z]:|:\/\//;
const HAS_BACKSLASH_RE = /\\/;

/**
 * Converte um caminho absoluto (dentro de `projectRoot`) em uma referência
 * relativa segura -- lança se o resultado ainda contiver `..` (arquivo fora
 * da raiz do projeto) ou continuar absoluto por algum motivo. NUNCA devolve
 * o caminho absoluto original em caso de erro -- a mensagem de erro só cita
 * o nome-base do arquivo, nunca o caminho completo.
 */
function toSafeSourceReference(absolutePath, projectRoot) {
  const relative = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
  if (UNSAFE_LOCAL_PATH_RE.test(relative) || HAS_BACKSLASH_RE.test(relative)) {
    throw new Error(`Path outside project root or unsafe: ${path.basename(absolutePath)}`);
  }
  return relative;
}

/** Referência de tipo `local_relative_path`: caminho relativo seguro, sem '\', sem esquema de URL, sem travessia. */
function isSafeLocalRelativePath(reference) {
  return (
    typeof reference === "string" &&
    reference.length > 0 &&
    reference.length <= 500 &&
    !UNSAFE_LOCAL_PATH_RE.test(reference) &&
    !HAS_BACKSLASH_RE.test(reference)
  );
}

// manual_reference é SÓ descrição curta de pendência (ex.: "Transcrição
// será fornecida manualmente pelo usuário") -- nunca um fragmento de
// caminho. Diferente de local_relative_path (que legitimamente usa '/'
// como separador de subpasta), aqui '/' e '\' são proibidos em QUALQUER
// posição, não só no início.
const MANUAL_REFERENCE_FORBIDDEN_RE = /\.\.|\/|\\|:\/\/|^[A-Za-z]:/;
// Rejeita um token ÚNICO sem espaço terminado em algo parecido com
// extensão de arquivo (ex.: "manual.pdf", "video.mp4") -- uma descrição de
// pendência de verdade é sempre uma frase com espaço; um nome de arquivo
// isolado nunca é, mesmo sem separador nenhum.
const BARE_FILENAME_RE = /^\S+\.[A-Za-z0-9]{1,10}$/;

/** Referência de tipo `manual_reference`: texto livre curto que NUNCA pode parecer caminho local, URL ou nome de arquivo isolado. Nunca infere/converte -- só aceita ou rejeita. */
function isSafeManualReference(reference) {
  return (
    typeof reference === "string" &&
    reference.trim().length > 0 &&
    reference.length <= 500 &&
    !MANUAL_REFERENCE_FORBIDDEN_RE.test(reference) &&
    !BARE_FILENAME_RE.test(reference)
  );
}

/**
 * Pra uso em qualquer log/erro que precise mencionar "qual arquivo" sem
 * vazar caminho pessoal -- só o nome-base, nunca diretórios acima dele.
 * Sempre string, nunca lança (entrada inesperada vira "unknown-file").
 */
function sanitizePathForLog(anyPath) {
  if (typeof anyPath !== "string" || anyPath.length === 0) return "unknown-file";
  return path.basename(anyPath);
}

module.exports = { toSafeSourceReference, isSafeLocalRelativePath, isSafeManualReference, sanitizePathForLog };

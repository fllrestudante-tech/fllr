// Validação de URL e proteção contra SSRF -- primeiro módulo da futura
// camada "Fontes de Inteligência" (fontes web confiáveis). Só valida e
// resolve de modo controlável -- NUNCA faz requisição HTTP. Conectores
// futuros (fora do escopo deste commit) são quem efetivamente busca
// conteúdo, sempre usando este módulo antes de qualquer conexão real.
//
// Fail-closed por padrão em toda decisão: qualquer ambiguidade, erro de
// parsing, DNS sem resposta ou endereço não-público vira REJEIÇÃO, nunca
// aprovação otimista. Nenhuma allowlist de domínios reais existe aqui --
// este módulo não sabe (e não deve saber) quais domínios o catálogo de
// fontes vai conter; ele só aplica regras estruturais válidas para
// QUALQUER URL.
//
// Reaproveita só APIs nativas do Node (net.isIP/isIPv4/isIPv6, dns.promises,
// WHATWG URL) -- não há biblioteca de IP/URL instalada no projeto
// (package.json não lista ip/ipaddr.js/is-ip), e nenhum validador
// equivalente existia em lib/ antes deste módulo (auditado antes de
// escrever este arquivo). A normalização de hostname/punycode vem de graça
// do parser WHATWG URL nativo (IDNA via ICU), não é reimplementada aqui.
const net = require("net");
const dns = require("dns");

const ALLOWED_SCHEMES = new Set(["https:"]);
// "" = porta padrão do esquema, omitida pelo próprio parser WHATWG URL
// (new URL("https://x:443/").port === "") -- é a ÚNICA porta aceita hoje.
// Ampliar isso pra uma allowlist de portas extras é decisão futura
// explícita, não algo que este módulo assume sozinho.
const ALLOWED_PORTS = new Set([""]);
const DEFAULT_MAX_REDIRECTS = 5;
// Limite conservador e explícito -- não existia antes desta rodada de
// endurecimento. 2048 é o mesmo teto historicamente citado como
// interoperável (IE legado, muitos servidores/CDNs) -- suficiente pra
// qualquer URL de fonte de notícia/API real, curto o bastante pra rejeitar
// tentativas de abuso (payload gigante, URL-bomb) sem custo de parsing.
const MAX_URL_LENGTH = 2048;
// Qualquer espaço (0x20) ou caractere de controle ASCII (0x00-0x1F, 0x7F)
// em QUALQUER posição da URL crua é rejeitado explicitamente, ANTES do
// parser WHATWG rodar -- não confiamos no comportamento implícito do
// parser aqui (observado nesta rodada: espaço no host FAZ o parser lançar,
// mas espaço no path é silenciosamente aceito e vira "%20", e tab/CR/LF em
// qualquer posição são REMOVIDOS da string pelo parser, não rejeitados --
// nenhum dos dois é "rejeição" no sentido pedido). Percent-encoding
// legítimo (ex: "%20") nunca contém o byte 0x20 cru, então não é afetado.
const CONTROL_OR_SPACE_RE = /[\x00-\x20\x7f]/;

// --- Classificação de IP (IPv4 e IPv6) -------------------------------

function ipv4ToBytes(ip) {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

// Node não expõe um "inet_pton" em JS -- parser manual, deliberadamente
// conservador: qualquer forma não reconhecida devolve `null` (tratado pelo
// chamador como "não foi possível classificar" -> NUNCA público, fail-closed).
// net.isIPv6() já validou a sintaxe geral antes de chegar aqui.
function ipv6ToBytes(input) {
  if (typeof input !== "string" || !net.isIPv6(input)) return null;
  let ip = input;

  // IPv4 embutido no final (::ffff:192.168.1.1, ::192.168.1.1, etc.) --
  // substitui por 2 grupos hex placeholder só pra contagem de grupos bater;
  // os 4 últimos bytes são sobrescritos pelo valor real do IPv4 depois.
  let embeddedV4 = null;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (net.isIPv4(tail)) {
    embeddedV4 = tail;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }

  let groups;
  if (ip.includes("::")) {
    const [leftStr, rightStr] = ip.split("::");
    if (ip.split("::").length > 2) return null; // "::" duplicado não é válido
    const left = leftStr ? leftStr.split(":") : [];
    const right = rightStr ? rightStr.split(":") : [];
    const fillCount = 8 - left.length - right.length;
    if (fillCount < 0) return null;
    groups = [...left, ...Array(fillCount).fill("0"), ...right];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const val = parseInt(g, 16);
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }

  if (embeddedV4) {
    const v4 = ipv4ToBytes(embeddedV4);
    if (!v4) return null;
    bytes[12] = v4[0];
    bytes[13] = v4[1];
    bytes[14] = v4[2];
    bytes[15] = v4[3];
  }
  return bytes;
}

// Categorias de bloqueio IPv4 -- cobre loopback, RFC1918 (privado),
// link-local (inclui 169.254.169.254, metadata de nuvem AWS/GCP/Azure),
// CGNAT (RFC6598), multicast, unspecified/this-network, documentação/teste
// (RFC5737), benchmarking (RFC2544) e reservado (classe E + broadcast).
function classifyIpv4(bytes) {
  const [a, b, c] = bytes;
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // inclui metadata de nuvem 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 0) return "unspecified";
  if (a >= 224 && a <= 239) return "multicast";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay anycast (histórico)
  if (a === 192 && b === 0 && c === 0) return "reserved"; // 192.0.0.0/24, IETF Protocol Assignments (RFC6890)
  if (a >= 240) return "reserved"; // classe E + 255.255.255.255
  return "public";
}

// Categorias de bloqueio IPv6 -- loopback (::1), unspecified (::),
// private/ULA (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
// documentação (2001:db8::/32).
//
// Mecanismos de transição IPv4<->IPv6 -- política deliberada, documentada
// aqui por completo (exigência da rodada de endurecimento adversarial):
//
//   - IPv4-mapped (::ffff:0:0/96, RFC4291, mecanismo ATUAL e onipresente --
//     é o que dns.lookup()/sockets dual-stack produzem de verdade) É
//     decodificado: reclassifica pelo IPv4 embutido (categoria
//     "ipv4-mapped-<categoria real>"). Único mecanismo de transição em que
//     confiamos decodificar, porque é inequívoco e amplamente auditado.
//
//   - IPv4-compatible (::a.b.c.d SEM o marcador ffff, RFC4291 -- DEPRECIADO
//     desde 2006), 6to4 (2002::/16, RFC3056) e Teredo (2001::/32, RFC4380)
//     são bloqueados POR INTEIRO, sem tentar decodificar o IPv4/endpoint
//     embutido -- nenhum sistema moderno deveria emitir essas formas, e
//     decodificá-las corretamente exigiria confiar em infraestrutura de
//     túnel/relay externa (6to4 usa relay anycast, Teredo ofusca o IPv4
//     real por XOR e depende de um servidor Teredo) que este módulo não
//     pode verificar como "comprovadamente segura". Falso negativo
//     (bloquear um destino que talvez fosse público) é preferível a um
//     bypass de SSRF por decodificação errada de um mecanismo legado.
//
//   - NAT64 well-known (64:ff9b::/96, RFC6052) também é bloqueado por
//     inteiro pelo mesmo motivo -- embora o IPv4 esteja embutido sem
//     ofuscação (diferente de Teredo), o destino real depende de um
//     gateway NAT64 específico da rede do resolvedor, não é uma
//     propriedade só do endereço.
//
// Faixas especiais adicionais (rodada de endurecimento adversarial):
// fec0::/10 (site-local, RFC3879, obsoleto), 2001:2::/48 (benchmarking,
// RFC5180), 2001:10::/28 e 2001:20::/28 (ORCHID/ORCHIDv2, RFC4843/RFC7343,
// endereços criptográficos não roteáveis, obsoletos), 3fff::/20
// (documentação adicional, RFC9637), 5f00::/16 (espaço reservado a SRv6
// SIDs, RFC9602). NENHUMA ALEGAÇÃO DE COBERTURA ETERNA: esta é uma
// fotografia dos registros IANA de special-purpose address conhecidos no
// momento em que este módulo foi escrito -- a IANA pode reservar faixas
// novas no futuro, e esta lista precisa de revisão periódica, não é
// tratada aqui como definitiva pra sempre.
function classifyIpv6(bytes) {
  const allZero = (from, to) => bytes.slice(from, to).every((n) => n === 0);

  if (allZero(0, 16)) return "unspecified";
  if (allZero(0, 15) && bytes[15] === 1) return "loopback";
  if (allZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4Category = classifyIpv4(bytes.slice(12, 16));
    return v4Category === "public" ? "ipv4-mapped-public" : `ipv4-mapped-${v4Category}`;
  }
  // IPv4-compatible (deprecado): bytes 0-11 zerados, mas NÃO é ::/128 nem
  // ::1/128 (já teriam retornado acima) -- só sobra a forma ::a.b.c.d pura.
  if (allZero(0, 12)) return "ipv4-compatible-deprecated";
  if ((bytes[0] & 0xfe) === 0xfc) return "private"; // fc00::/7 (ULA)
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return "site-local-deprecated"; // fec0::/10 (RFC3879)
  if (bytes[0] === 0xff) return "multicast"; // ff00::/8
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "documentation"; // 2001:db8::/32
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return "benchmarking-v6"; // 2001:2::/48
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x10) return "orchid-deprecated"; // 2001:10::/28
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x20) return "orchidv2"; // 2001:20::/28
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return "teredo"; // 2001::/32
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return "6to4"; // 2002::/16
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0x00) return "documentation"; // 3fff::/20 (RFC9637)
  if (bytes[0] === 0x5f && bytes[1] === 0x00) return "reserved"; // 5f00::/16 (SRv6 SIDs, RFC9602)
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && allZero(4, 12)) return "nat64-well-known"; // 64:ff9b::/96
  return "public";
}

/**
 * Classifica um endereço IP literal (string). Nunca lança -- entrada
 * inválida/não reconhecida sempre vira category:"invalid" (fail-closed: o
 * chamador trata qualquer coisa != "public" como bloqueado).
 */
function classifyIp(ipStr) {
  if (typeof ipStr !== "string") return { version: null, category: "invalid" };
  if (net.isIPv4(ipStr)) {
    const bytes = ipv4ToBytes(ipStr);
    return bytes ? { version: 4, category: classifyIpv4(bytes) } : { version: 4, category: "invalid" };
  }
  if (net.isIPv6(ipStr)) {
    const bytes = ipv6ToBytes(ipStr);
    return bytes ? { version: 6, category: classifyIpv6(bytes) } : { version: 6, category: "invalid" };
  }
  return { version: null, category: "invalid" };
}

// "ipv4-mapped-public" é o ÚNICO outro valor de categoria tratado como
// seguro/público além do literal "public" -- é a mesma coisa por definição
// (::ffff:8.8.8.8 alcança exatamente o mesmo host que 8.8.8.8), só com o
// rótulo extra pra preservar a informação de que veio de uma forma mapeada.
// Nenhuma outra categoria (incluindo "ipv4-mapped-private"/"-loopback"/etc
// e todos os mecanismos de transição bloqueados por inteiro) é considerada seguro
// aqui -- usado por TODO ponto de decisão do módulo (isPublicIp,
// validateInitialUrl, resolveAndValidateAddresses), nunca comparação
// duplicada e potencialmente divergente em cada lugar.
function isPublicCategory(category) {
  return category === "public" || category === "ipv4-mapped-public";
}

function isPublicIp(ipStr) {
  return isPublicCategory(classifyIp(ipStr).category);
}

// --- Validação da STRING crua (antes de qualquer parsing) --------------

/**
 * Checagens que precisam rodar sobre a string exatamente como recebida,
 * ANTES de qualquer `new URL()` -- o construtor WHATWG já normaliza/mexe na
 * string internamente (observado nesta rodada: espaço no host faz o parser
 * lançar, mas espaço no path vira "%20" silenciosamente, e tab/CR/LF em
 * qualquer posição são REMOVIDOS pelo parser, não rejeitados). Usada tanto
 * por validateInitialUrl() quanto no início de validateHop(), pra que
 * redirects também passem por aqui antes do `new URL(rawUrl, baseUrl)`
 * interno de validateHop() ter chance de normalizar a string primeiro.
 * Devolve `null` se a string está OK, ou o objeto de rejeição pronto.
 */
function checkRawUrlString(rawUrl) {
  if (typeof rawUrl !== "string") {
    return { ok: false, code: "URL_UNPARSEABLE", reason: "URL must be a string" };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, code: "URL_TOO_LONG", reason: `URL exceeds the maximum length of ${MAX_URL_LENGTH} characters` };
  }
  if (CONTROL_OR_SPACE_RE.test(rawUrl)) {
    return { ok: false, code: "URL_CONTAINS_CONTROL_CHARS", reason: "URL must not contain whitespace or control characters" };
  }
  return null;
}

// --- Validação estrutural da URL (sem DNS) ----------------------------

/**
 * Só sintaxe/esquema/porta/credenciais/hostname -- nenhuma resolução de
 * rede acontece aqui. Fragmento é sempre removido da URL canônica
 * devolvida (nunca é enviado a um servidor por HTTP, então não tem
 * finalidade de coleta -- documentado aqui, não rejeitado como erro).
 */
function validateInitialUrl(rawUrl) {
  const rawCheck = checkRawUrlString(rawUrl);
  if (rawCheck) return rawCheck;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, code: "URL_UNPARSEABLE", reason: "URL could not be parsed" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, code: "SCHEME_NOT_ALLOWED", reason: `Scheme "${parsed.protocol}" is not allowed` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, code: "CREDENTIALS_IN_URL", reason: "URL must not contain embedded credentials" };
  }
  if (!parsed.hostname) {
    return { ok: false, code: "HOSTNAME_EMPTY", reason: "URL hostname is empty" };
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    return { ok: false, code: "PORT_NOT_ALLOWED", reason: `Port "${parsed.port}" is not allowed` };
  }

  // Hostname já normalizado (minúsculo, punycode) pelo próprio parser
  // WHATWG URL -- só removemos um ponto final residual (FQDN) antes de
  // comparar contra "localhost". Casamento por LABEL exato, nunca
  // substring -- "localhost.attacker.example" (label "localhost" seguido
  // de outro domínio) não é bloqueado aqui por texto; sua segurança real
  // depende da resolução DNS de "attacker.example" (etapa seguinte). Só
  // "localhost" exato ou um verdadeiro subdomínio ("*.localhost") é
  // bloqueado por nome, por ser reserva conhecida (RFC 6761).
  const hostname = parsed.hostname.replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, code: "LOCALHOST_BLOCKED", reason: "localhost and its subdomains are blocked" };
  }

  const literalIp = hostname.replace(/^\[|\]$/g, "");
  const ipVersion = net.isIP(literalIp);
  if (ipVersion !== 0) {
    const { category } = classifyIp(literalIp);
    if (!isPublicCategory(category)) {
      return { ok: false, code: "IP_NOT_PUBLIC", reason: `IP address category "${category}" is not allowed` };
    }
  }

  parsed.hash = "";
  return { ok: true, url: parsed.toString(), hostname, isLiteralIp: ipVersion !== 0, literalIp: ipVersion !== 0 ? literalIp : null };
}

// --- Resolução DNS + validação de TODOS os endereços -------------------

// dns.promises.lookup real -- só usado em produção; NUNCA chamado nos
// testes (resolveFn é sempre injetado lá, ver test/collectors/sources/urlSafety.test.js).
async function defaultResolveFn(hostname) {
  const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

// Aceita tanto uma string ("8.8.8.8") quanto um objeto {address, family}
// (formato de dns.promises.lookup(...,{all:true})) por item -- resolveFn
// injetado por um conector futuro pode devolver qualquer um dos dois.
//
// POLÍTICA ESTRITA (deliberada, exigência da rodada de endurecimento):
//   - string: só precisa ser um IP válido -- resolvedores injetados que só
//     devolvem strings continuam funcionando sem exigir campo extra.
//   - objeto: `address` precisa ser IP válido E `family` precisa ser
//     EXATAMENTE o número 4 ou 6 (nunca "4" string, nunca 0, nunca outro
//     número, nunca ausente/null/undefined) E bater com a versão real do
//     endereço. Um objeto SEM family, ou com family fora de {4,6}, FALHA --
//     nunca é tratado como "ok, ignora o family". A informação declarada
//     tem que ser exata quando presente; a ausência dela é só tolerada na
//     forma mais simples (string pura), nunca num objeto que já se propôs
//     a declarar family e errou.
//
// Devolve `null` pra QUALQUER item malformado -- nunca inventa/ignora, o
// chamador trata `null` como falha da resolução inteira.
function normalizeResolvedItem(item) {
  if (typeof item === "string") {
    return net.isIP(item) === 0 ? null : item;
  }
  if (item && typeof item === "object" && typeof item.address === "string") {
    const actualVersion = net.isIP(item.address);
    if (actualVersion === 0) return null; // address presente, mas não é IP válido
    if (item.family !== 4 && item.family !== 6) return null; // política estrita: family ausente/tipo errado/valor fora de {4,6} sempre falha em objetos
    if (item.family !== actualVersion) return null; // family declarada não bate com a versão real do endereço
    return item.address;
  }
  return null; // nem string, nem {address:string}, nem nada reconhecível
}

/**
 * Resolve `hostname` via resolveFn (injetável -- produção usa dns real,
 * testes usam fake sem rede) e classifica CADA endereço devolvido, não só
 * o primeiro. Falha se: o DNS não devolver nada; devolver algo que não é
 * array; QUALQUER item for malformado (normalizeResolvedItem); ou QUALQUER
 * endereço resolvido não for público (mistura pública+privada é rejeitada
 * por inteiro -- nunca "usa só o público e ignora o resto"). Nenhum
 * elemento malformado é silenciosamente descartado -- um só já derruba a
 * resolução inteira.
 */
async function resolveAndValidateAddresses(hostname, { resolveFn = defaultResolveFn } = {}) {
  let rawAddresses;
  try {
    rawAddresses = await resolveFn(hostname);
  } catch (err) {
    return { ok: false, code: "DNS_RESOLUTION_FAILED", reason: "DNS resolution failed" };
  }
  if (!Array.isArray(rawAddresses) || rawAddresses.length === 0) {
    return { ok: false, code: "DNS_NO_ADDRESSES", reason: "DNS returned no addresses" };
  }

  const normalized = rawAddresses.map(normalizeResolvedItem);
  if (normalized.some((address) => address === null)) {
    return { ok: false, code: "DNS_MALFORMED_RESULT", reason: "DNS resolver returned a malformed or inconsistent result" };
  }

  const classified = normalized.map((address) => ({ address, ...classifyIp(address) }));
  const nonPublic = classified.filter((c) => !isPublicCategory(c.category));
  if (nonPublic.length > 0) {
    return { ok: false, code: "DNS_RESOLVED_NON_PUBLIC", reason: "One or more resolved addresses are not public", addresses: classified };
  }
  return { ok: true, addresses: classified };
}

// --- API principal: uma "parada" (URL inicial OU cada redirect) --------

/**
 * Função única usada tanto para a URL inicial quanto para CADA redirect
 * (mesma validação estrutural + DNS + IP em ambos os casos -- "destino
 * final" é só o último `validateHop` de uma cadeia que devolveu ok:true).
 * `baseUrl` resolve Location relativo (RFC 7231) contra a URL anterior.
 * `redirectCount`/`maxRedirects` implementam o limite de redirects -- ambos
 * validados estritamente (inteiro >= 0); um valor inválido (negativo,
 * fracionário, NaN, string, `null`) FALHA explicitamente, nunca é coagido
 * silenciosamente pra um número através de comparação solta.
 *
 * CONTRATO DEVOLVIDO AO CONSUMIDOR (em caso de ok:true): `hostname`
 * (normalizado), `url` (canônica, sem fragmento), e `addresses` (TODOS os
 * IPs já validados como públicos NESTA chamada, cada um com `.address`) --
 * dados suficientes pra fixar (pin) a conexão real num desses IPs enquanto
 * preserva TLS/SNI e o header Host usando `hostname` (a maioria dos
 * clientes HTTP aceita um override de `lookup`/`family`/IP de destino
 * separado do Host/SNI enviado -- é assim que se conecta a um IP fixo sem
 * perder a identidade do certificado/virtual host).
 *
 * PROTEÇÃO CONTRA DNS REBINDING -- CONTRATO OBRIGATÓRIO, sem alternativa
 * mais fraca. Este módulo NÃO elimina rebinding sozinho -- ele só GARANTE
 * que, no MOMENTO desta chamada, os endereços em `addresses` eram públicos.
 * Ele não abre nenhuma conexão. A eliminação de fato do rebinding é
 * responsabilidade do CONECTOR FUTURO, que deve implementar e testar o
 * seguinte vínculo entre validação e socket, sem desvio:
 *
 *   1. A conexão TCP/TLS real DEVE ser fixada (pinned) em um dos IPs
 *      devolvidos em `addresses` desta chamada -- nunca deixar a
 *      biblioteca HTTP resolver `hostname` de novo por conta própria no
 *      momento de conectar (isso reintroduziria exatamente a janela de
 *      rebinding que este módulo existe pra fechar).
 *   2. `Host` (HTTP) e SNI (TLS ClientHello) DEVEM continuar usando
 *      `hostname` -- o IP fixado é só o destino de transporte, nunca some
 *      da identidade do virtual host/certificado.
 *   3. Cada NOVA tentativa de conexão (retry, keep-alive expirado, nova
 *      requisição) precisa de um IP validado PRA AQUELA tentativa
 *      especificamente -- reaproveitar indefinidamente um `addresses` de
 *      uma validação antiga é PROIBIDO, mesmo que "funcionasse da última
 *      vez".
 *   4. Cada redirect é uma nova chamada a `validateHop()` (`baseUrl` = URL
 *      anterior, `redirectCount` incrementado) e produz seu PRÓPRIO
 *      conjunto de IPs fixáveis -- nunca reaproveitar os `addresses` de um
 *      hop anterior para o destino de um hop seguinte.
 *   5. "Revalidar e DEPOIS permitir que a lib HTTP faça uma segunda
 *      resolução DNS independente" continua PROIBIDO isoladamente -- entre
 *      essa revalidação e a segunda resolução independente, a resposta do
 *      DNS pode já ter mudado; revalidar só vale alguma coisa se o
 *      resultado dela for o IP efetivamente usado na conexão (regra 1),
 *      nunca um mero cheque descartado em seguida.
 *
 * Não há uma alternativa "(b) só revalidar antes de conectar" que dispense
 * a regra 1 -- as duas coisas (revalidar + fixar no IP validado) são partes
 * da MESMA obrigação, não escolhas independentes.
 */
async function validateHop(rawUrl, { baseUrl = null, redirectCount = 0, maxRedirects = DEFAULT_MAX_REDIRECTS, resolveFn } = {}) {
  if (!Number.isInteger(redirectCount) || redirectCount < 0) {
    return { ok: false, code: "INVALID_REDIRECT_COUNT", reason: "redirectCount must be a non-negative integer" };
  }
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    return { ok: false, code: "INVALID_MAX_REDIRECTS", reason: "maxRedirects must be a non-negative integer" };
  }
  if (redirectCount > maxRedirects) {
    return { ok: false, code: "REDIRECT_LIMIT_EXCEEDED", reason: `Redirect limit of ${maxRedirects} exceeded` };
  }

  const rawCheck = checkRawUrlString(rawUrl);
  if (rawCheck) return rawCheck;

  let absoluteUrl;
  try {
    absoluteUrl = baseUrl ? new URL(rawUrl, baseUrl).toString() : new URL(rawUrl).toString();
  } catch {
    return { ok: false, code: "URL_UNPARSEABLE", reason: "URL could not be resolved" };
  }

  const initial = validateInitialUrl(absoluteUrl);
  if (!initial.ok) return initial;

  if (initial.isLiteralIp) {
    return {
      ok: true,
      url: initial.url,
      hostname: initial.hostname,
      addresses: [{ address: initial.literalIp, ...classifyIp(initial.literalIp) }],
      redirectCount,
    };
  }

  const dnsResult = await resolveAndValidateAddresses(initial.hostname, { resolveFn });
  if (!dnsResult.ok) return dnsResult;

  return { ok: true, url: initial.url, hostname: initial.hostname, addresses: dnsResult.addresses, redirectCount };
}

module.exports = {
  validateHop,
  validateInitialUrl,
  resolveAndValidateAddresses,
  classifyIp,
  isPublicIp,
  isPublicCategory,
  ALLOWED_SCHEMES,
  ALLOWED_PORTS,
  DEFAULT_MAX_REDIRECTS,
  MAX_URL_LENGTH,
};

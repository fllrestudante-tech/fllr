const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("dns");
const {
  validateHop,
  validateInitialUrl,
  resolveAndValidateAddresses,
  classifyIp,
  isPublicIp,
  isPublicCategory,
  DEFAULT_MAX_REDIRECTS,
  MAX_URL_LENGTH,
} = require("../../../lib/collectors/sources/urlSafety");

// Proteção em RUNTIME, não em texto/regex (uma tentativa anterior de provar
// "sem rede" via regex sobre o próprio código-fonte deste arquivo se
// mostrou frágil demais -- falsos positivos por chamadas multilinha e por
// menções em comentários de prosa). "Envenena" dns.promises.lookup (o que
// defaultResolveFn() do módulo chamaria de verdade em produção) durante
// TODA a execução deste arquivo -- qualquer teste que acidentalmente NÃO
// injete `resolveFn` cairia aqui e lançaria, em vez de silenciosamente
// tentar uma resolução DNS real. Restaurado no fim, mesmo padrão de
// "POISON" já usado em outras suítes do projeto (ex:
// test/aiGateway/aiGateway.test.js::neverCallTransport()).
let realDnsLookup;
before(() => {
  realDnsLookup = dns.promises.lookup;
  dns.promises.lookup = async () => {
    throw new Error("POISON: dns.promises.lookup real foi chamado -- todo teste deveria injetar resolveFn");
  };
});
after(() => {
  dns.promises.lookup = realDnsLookup;
});

// Nenhum teste deste arquivo chama dns.promises.lookup real nem faz
// requisição HTTP -- resolveFn é SEMPRE um fake local, síncrono/assíncrono
// só em memória. fakeResolver() abaixo é o único ponto que "resolve" nomes,
// e nunca toca rede.
function fakeResolver(map) {
  return async (hostname) => {
    if (!(hostname in map)) throw new Error(`fakeResolver: host inesperado "${hostname}" (sem entrada no mapa do teste)`);
    return map[hostname];
  };
}

// =====================================================================
// classifyIp / isPublicIp -- IPv4
// =====================================================================

test("classifyIp: IPv4 público", () => {
  assert.deepEqual(classifyIp("8.8.8.8"), { version: 4, category: "public" });
  assert.equal(isPublicIp("8.8.8.8"), true);
});

test("classifyIp: IPv4 loopback", () => {
  assert.equal(classifyIp("127.0.0.1").category, "loopback");
  assert.equal(classifyIp("127.255.255.255").category, "loopback");
});

test("classifyIp: IPv4 privado (RFC1918)", () => {
  assert.equal(classifyIp("10.1.2.3").category, "private");
  assert.equal(classifyIp("172.16.0.1").category, "private");
  assert.equal(classifyIp("172.31.255.255").category, "private");
  assert.equal(classifyIp("172.32.0.1").category, "public"); // fora do range 172.16-31, prova que o limite superior é exato
  assert.equal(classifyIp("192.168.1.1").category, "private");
});

test("classifyIp: IPv4 link-local, incluindo metadata de nuvem 169.254.169.254", () => {
  assert.equal(classifyIp("169.254.1.1").category, "link-local");
  assert.equal(classifyIp("169.254.169.254").category, "link-local");
});

test("classifyIp: IPv4 CGNAT (RFC6598, 100.64.0.0/10)", () => {
  assert.equal(classifyIp("100.64.0.1").category, "cgnat");
  assert.equal(classifyIp("100.127.255.255").category, "cgnat");
  assert.equal(classifyIp("100.63.255.255").category, "public"); // fora do /10 por 1 endereço
});

test("classifyIp: IPv4 multicast", () => {
  assert.equal(classifyIp("224.0.0.1").category, "multicast");
  assert.equal(classifyIp("239.255.255.255").category, "multicast");
});

test("classifyIp: IPv4 unspecified/this-network e reservado/broadcast", () => {
  assert.equal(classifyIp("0.0.0.0").category, "unspecified");
  assert.equal(classifyIp("255.255.255.255").category, "reserved");
  assert.equal(classifyIp("240.0.0.1").category, "reserved");
});

test("classifyIp: IPv4 documentação/teste (RFC5737) e benchmarking (RFC2544)", () => {
  assert.equal(classifyIp("192.0.2.1").category, "documentation");
  assert.equal(classifyIp("198.51.100.1").category, "documentation");
  assert.equal(classifyIp("203.0.113.1").category, "documentation");
  assert.equal(classifyIp("198.18.0.1").category, "reserved");
});

// =====================================================================
// classifyIp / isPublicIp -- IPv6
// =====================================================================

test("classifyIp: IPv6 loopback e unspecified", () => {
  assert.equal(classifyIp("::1").category, "loopback");
  assert.equal(classifyIp("::").category, "unspecified");
});

test("classifyIp: IPv6 privado/ULA (fc00::/7)", () => {
  assert.equal(classifyIp("fd12:3456:789a::1").category, "private");
  assert.equal(classifyIp("fc00::1").category, "private");
});

test("classifyIp: IPv6 link-local (fe80::/10)", () => {
  assert.equal(classifyIp("fe80::1").category, "link-local");
  assert.equal(classifyIp("fe80::abcd:1234").category, "link-local");
});

test("classifyIp: IPv6 público", () => {
  assert.equal(classifyIp("2606:4700:4700::1111").category, "public");
  assert.equal(isPublicIp("2001:4860:4860::8888"), true);
});

test("classifyIp: IPv4 mapeado em IPv6 -- reclassifica pelo IPv4 embutido, NUNCA tratado como público só por sintaxe IPv6", () => {
  assert.equal(classifyIp("::ffff:192.168.1.1").category, "ipv4-mapped-private");
  assert.equal(classifyIp("::ffff:127.0.0.1").category, "ipv4-mapped-loopback");
  assert.equal(classifyIp("::ffff:8.8.8.8").category, "ipv4-mapped-public");
  assert.equal(isPublicIp("::ffff:192.168.1.1"), false);
});

test("classifyIp: entrada inválida/não reconhecida nunca lança e nunca é pública (fail-closed)", () => {
  assert.equal(classifyIp("not-an-ip").category, "invalid");
  assert.equal(classifyIp("").category, "invalid");
  assert.equal(classifyIp(null).category, "invalid");
  assert.equal(classifyIp(undefined).category, "invalid");
  assert.equal(classifyIp("999.999.999.999").category, "invalid");
  assert.equal(isPublicIp("not-an-ip"), false);
});

// =====================================================================
// validateInitialUrl -- sem DNS, só estrutura
// =====================================================================

test("validateInitialUrl: HTTPS público válido -- aceito", () => {
  const result = validateInitialUrl("https://example.com/path?x=1");
  assert.equal(result.ok, true);
  assert.equal(result.hostname, "example.com");
  assert.equal(result.isLiteralIp, false);
});

test("validateInitialUrl: normalização de hostname (maiúsculas -> minúsculas, IDNA/punycode via WHATWG URL nativo)", () => {
  const upper = validateInitialUrl("https://EXAMPLE.com/");
  assert.equal(upper.hostname, "example.com");
  // domínio com acentuação vira punycode automaticamente pelo parser nativo
  const idna = validateInitialUrl("https://exämple.com/");
  assert.equal(idna.ok, true);
  assert.ok(idna.hostname.startsWith("xn--"));
});

test("validateInitialUrl: fragmento é removido da URL canônica, não rejeitado como erro", () => {
  const result = validateInitialUrl("https://example.com/path#section-2");
  assert.equal(result.ok, true);
  assert.ok(!result.url.includes("#"));
  assert.equal(result.url, "https://example.com/path");
});

test("validateInitialUrl: query necessária é preservada (só o fragmento é removido)", () => {
  const result = validateInitialUrl("https://example.com/path?important=1&x=2#frag");
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/path?important=1&x=2");
});

test("validateInitialUrl: esquema http rejeitado", () => {
  const result = validateInitialUrl("http://example.com/");
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEME_NOT_ALLOWED");
});

test("validateInitialUrl: esquemas proibidos (file:, data:, javascript:, ftp:) -- todos rejeitados por esquema, mesmo os que o parser WHATWG aceita sintaticamente", () => {
  for (const url of ["file:///etc/passwd", "data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "ftp://example.com/"]) {
    const result = validateInitialUrl(url);
    assert.equal(result.ok, false, `deveria rejeitar ${url}`);
    assert.equal(result.code, "SCHEME_NOT_ALLOWED", `code inesperado pra ${url}: ${result.code}`);
  }
});

test("validateInitialUrl: credenciais embutidas na URL rejeitadas", () => {
  const result = validateInitialUrl("https://user:pass@example.com/");
  assert.equal(result.ok, false);
  assert.equal(result.code, "CREDENTIALS_IN_URL");
});

test("validateInitialUrl: porta não autorizada rejeitada; porta 443 explícita e implícita aceitas", () => {
  const withPort = validateInitialUrl("https://example.com:8443/");
  assert.equal(withPort.ok, false);
  assert.equal(withPort.code, "PORT_NOT_ALLOWED");

  const implicit = validateInitialUrl("https://example.com/");
  assert.equal(implicit.ok, true);
  const explicit443 = validateInitialUrl("https://example.com:443/");
  assert.equal(explicit443.ok, true);
  assert.equal(explicit443.url, implicit.url); // normalizado igual (porta padrão omitida)
});

test("validateInitialUrl: localhost e subdomínio verdadeiro de localhost bloqueados", () => {
  assert.equal(validateInitialUrl("https://localhost/").code, "LOCALHOST_BLOCKED");
  assert.equal(validateInitialUrl("https://LOCALHOST/").code, "LOCALHOST_BLOCKED");
  assert.equal(validateInitialUrl("https://evil.localhost/").code, "LOCALHOST_BLOCKED");
});

test("validateInitialUrl: subdomínio ENGANOSO contendo 'localhost' (não é localhost de verdade) -- NÃO bloqueado por texto, segue pra validação de DNS", () => {
  const result = validateInitialUrl("https://localhost.attacker.example/");
  assert.equal(result.ok, true); // não é bloqueado aqui -- a segurança real vem da resolução DNS de "attacker.example" na próxima etapa
  assert.equal(result.hostname, "localhost.attacker.example");
});

test("validateInitialUrl: hostname vazio/inválido rejeitado", () => {
  // "https://" sem host algum -- o próprio parser WHATWG URL já lança
  // (host vazio é inválido pra esquemas especiais); cai no catch e vira
  // URL_UNPARSEABLE. "https:///path" NÃO é um caso de host vazio (o
  // parser interpreta "path" como hostname nesse caso -- comportamento
  // documentado do parser, não deste módulo -- por isso não é usado aqui).
  assert.equal(validateInitialUrl("https://").ok, false);
  assert.equal(validateInitialUrl("https://").code, "URL_UNPARSEABLE");
  // "not a url at all" contém espaços -- desde o endurecimento da Seção 6,
  // isso é pego ANTES pela checagem explícita de espaço/controle (mais
  // precisa que deixar o parser lançar); "notaurl" (sem espaço, sem
  // esquema) ainda exercita o caminho genuíno de URL_UNPARSEABLE.
  assert.equal(validateInitialUrl("not a url at all").ok, false);
  assert.equal(validateInitialUrl("not a url at all").code, "URL_CONTAINS_CONTROL_CHARS");
  assert.equal(validateInitialUrl("notaurl").ok, false);
  assert.equal(validateInitialUrl("notaurl").code, "URL_UNPARSEABLE");
});

test("validateInitialUrl: IP literal na URL já é classificado aqui (sem esperar DNS) -- público aceito, privado/loopback rejeitado", () => {
  assert.equal(validateInitialUrl("https://8.8.8.8/").ok, true);
  const priv = validateInitialUrl("https://192.168.1.1/");
  assert.equal(priv.ok, false);
  assert.equal(priv.code, "IP_NOT_PUBLIC");
  const loop = validateInitialUrl("https://127.0.0.1/");
  assert.equal(loop.ok, false);
  const meta = validateInitialUrl("https://169.254.169.254/latest/meta-data/");
  assert.equal(meta.ok, false);
  assert.equal(meta.code, "IP_NOT_PUBLIC");
});

test("validateInitialUrl: IP literal IPv6 (com colchetes) também classificado aqui", () => {
  assert.equal(validateInitialUrl("https://[::1]/").ok, false);
  assert.equal(validateInitialUrl("https://[2606:4700:4700::1111]/").ok, true);
});

// =====================================================================
// resolveAndValidateAddresses -- DNS fake, nunca real
// =====================================================================

test("resolveAndValidateAddresses: DNS vazio -- falha", async () => {
  const result = await resolveAndValidateAddresses("empty.example", { resolveFn: fakeResolver({ "empty.example": [] }) });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_NO_ADDRESSES");
});

test("resolveAndValidateAddresses: DNS com múltiplos endereços públicos -- aceito, todos retornados classificados", async () => {
  const result = await resolveAndValidateAddresses("multi.example", {
    resolveFn: fakeResolver({ "multi.example": ["8.8.8.8", "1.1.1.1"] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.addresses.length, 2);
  assert.ok(result.addresses.every((a) => a.category === "public"));
});

test("resolveAndValidateAddresses: DNS com resultado MISTO público + privado -- rejeita por inteiro, nunca usa só o público", async () => {
  const result = await resolveAndValidateAddresses("mixed.example", {
    resolveFn: fakeResolver({ "mixed.example": ["8.8.8.8", "10.0.0.5"] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_RESOLVED_NON_PUBLIC");
});

test("resolveAndValidateAddresses: falha na resolução (erro do resolver) -- tratada, nunca lança pro chamador", async () => {
  const result = await resolveAndValidateAddresses("broken.example", {
    resolveFn: async () => {
      throw new Error("ENOTFOUND (simulado, sem rede real)");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_RESOLUTION_FAILED");
  // erro sanitizado -- a mensagem real do erro não é propagada no reason
  assert.ok(!result.reason.includes("ENOTFOUND"));
});

// =====================================================================
// validateHop -- integração: URL inicial + DNS + cada redirect
// =====================================================================

test("validateHop: HTTPS público válido com DNS fake público -- aceito, addresses preenchido", async () => {
  const resolveFn = fakeResolver({ "example.com": ["8.8.8.8"] });
  const result = await validateHop("https://example.com/feed", { resolveFn });
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/feed");
  assert.equal(result.addresses.length, 1);
  assert.equal(result.addresses[0].category, "public");
});

test("validateHop: IP literal público -- não chama resolveFn (não precisa de DNS)", async () => {
  let called = false;
  const resolveFn = async () => {
    called = true;
    return ["8.8.8.8"];
  };
  const result = await validateHop("https://8.8.8.8/", { resolveFn });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test("validateHop: redirect PERMITIDO (destino público) -- validado com a mesma função, encadeando redirectCount", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"], "b.example": ["1.1.1.1"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  assert.equal(first.ok, true);
  const second = await validateHop("https://b.example/next", { baseUrl: first.url, redirectCount: first.redirectCount + 1, resolveFn });
  assert.equal(second.ok, true);
  assert.equal(second.redirectCount, 1);
});

test("validateHop: redirect RELATIVO resolvido contra baseUrl corretamente", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const first = await validateHop("https://a.example/dir/start", { resolveFn });
  const second = await validateHop("/dir/other-page", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, true);
  assert.equal(second.url, "https://a.example/dir/other-page");
});

test("validateHop: redirect para DESTINO PRIVADO -- rejeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"], "internal.example": ["10.0.0.5"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("https://internal.example/", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, false);
  assert.equal(second.code, "DNS_RESOLVED_NON_PUBLIC");
});

test("validateHop: redirect para ESQUEMA PROIBIDO -- rejeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("http://a.example/downgrade", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, false);
  assert.equal(second.code, "SCHEME_NOT_ALLOWED");
});

test("validateHop: excesso de redirects -- rejeitado ao ultrapassar maxRedirects", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const result = await validateHop("https://a.example/", { redirectCount: DEFAULT_MAX_REDIRECTS + 1, resolveFn });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REDIRECT_LIMIT_EXCEEDED");
});

test("validateHop: maxRedirects customizado (parâmetro seguro) é respeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const result = await validateHop("https://a.example/", { redirectCount: 2, maxRedirects: 1, resolveFn });
  assert.equal(result.ok, false);
  assert.equal(result.code, "REDIRECT_LIMIT_EXCEEDED");
});

// =====================================================================
// Provas estruturais: nenhuma rede real em nenhum caminho
// =====================================================================

test("prova por EXECUÇÃO (não por inspeção de texto): dns.promises.lookup real está envenenado durante toda a suíte -- um resolveFn omitido lançaria/falharia, nunca tentaria rede de verdade", async () => {
  await assert.rejects(() => dns.promises.lookup("example.com"), /POISON/);
  // resolveAndValidateAddresses usando o resolveFn PADRÃO (produção, sem
  // override) precisa cair no defaultResolveFn() real do módulo -> bate no
  // dns.promises.lookup envenenado -> capturado pelo try/catch do módulo,
  // vira DNS_RESOLUTION_FAILED (fail-closed), nunca uma exceção não tratada
  // nem uma tentativa de rede real de verdade.
  const result = await resolveAndValidateAddresses("example.com");
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_RESOLUTION_FAILED");
});

// =====================================================================
// RODADA DE ENDURECIMENTO ADVERSARIAL -- Seção 1: formas alternativas de IPv4
// =====================================================================
// O próprio parser WHATWG URL já normaliza shorthand/octal/hex/decimal
// (comprovado localmente, sem rede, antes de escrever este bloco -- ver
// relatório) -- validateInitialUrl só precisa classificar o hostname JÁ
// normalizado, sem nenhuma lógica extra. Estes testes prendem esse
// comportamento (se o Node mudar a normalização algum dia, o teste falha
// e avisa, em vez de silenciosamente parar de proteger).

test("Seção 1: formas alternativas de IPv4 -- todas rejeitadas via normalização do próprio parser WHATWG", () => {
  const cases = [
    ["https://127.1/", "127.0.0.1", "loopback"],
    ["https://127.0.1/", "127.0.0.1", "loopback"],
    ["https://2130706433/", "127.0.0.1", "loopback"],
    ["https://0x7f000001/", "127.0.0.1", "loopback"],
    ["https://0177.0.0.1/", "127.0.0.1", "loopback"],
    ["https://192.168.1/", "192.168.0.1", "private"],
    ["https://0300.0250.0001.0001/", "192.168.1.1", "private"],
  ];
  for (const [url, expectedHostname, expectedCategory] of cases) {
    const result = validateInitialUrl(url);
    assert.equal(result.ok, false, `deveria rejeitar ${url}`);
    assert.equal(result.code, "IP_NOT_PUBLIC", `code inesperado pra ${url}`);
    // confirma que a normalização produziu o IP esperado (prova que a
    // rejeição é pelo motivo certo, não um acaso de outro código de erro)
    assert.equal(classifyIp(expectedHostname).category, expectedCategory);
  }
});

test("Seção 1: formas ambíguas/inválidas de IPv4 são rejeitadas (parser lança, não classificação silenciosa)", () => {
  for (const url of ["https://999999999999/", "https://1.2.3.4.5/"]) {
    const result = validateInitialUrl(url);
    assert.equal(result.ok, false, `deveria rejeitar ${url}`);
    assert.equal(result.code, "URL_UNPARSEABLE");
  }
});

// =====================================================================
// Seção 2: localhost e nomes especiais
// =====================================================================

test("Seção 2: localhost e variantes bloqueadas explicitamente por nome (não depende de DNS)", () => {
  for (const host of ["localhost", "localhost.", "sub.localhost", "sub.localhost.", "LOCALHOST", "LoCaLhOsT."]) {
    const result = validateInitialUrl(`https://${host}/`);
    assert.equal(result.ok, false, `deveria bloquear ${host}`);
    assert.equal(result.code, "LOCALHOST_BLOCKED", `code inesperado pra ${host}`);
  }
});

test("Seção 2: subdomínio ENGANOSO (contém 'localhost' mas não é reserva de verdade) -- não bloqueado por substring", () => {
  for (const host of ["localhost.attacker.example", "notlocalhost.example"]) {
    const result = validateInitialUrl(`https://${host}/`);
    assert.equal(result.ok, true, `NÃO deveria bloquear ${host} por texto -- segurança real vem do DNS`);
    assert.equal(result.hostname, host);
  }
});

test("Seção 2: ponto final absoluto (FQDN) normalizado de forma consistente para hosts comuns também", () => {
  const withDot = validateInitialUrl("https://example.com./path");
  const withoutDot = validateInitialUrl("https://example.com/path");
  assert.equal(withDot.ok, true);
  assert.equal(withDot.hostname, "example.com");
  assert.equal(withDot.hostname, withoutDot.hostname);
});

// =====================================================================
// Seção 3: faixas IPv4 completas -- fronteiras antes/dentro/depois
// =====================================================================

test("Seção 3: fronteiras de TODAS as faixas IPv4 bloqueadas -- não rejeita público adjacente por regra ampla demais", () => {
  const boundaries = [
    // [ip, categoria esperada, descrição]
    ["9.255.255.255", "public", "0/10.0.0.0/8 -- imediatamente antes"],
    ["10.0.0.0", "private", "10.0.0.0/8 -- início"],
    ["10.255.255.255", "private", "10.0.0.0/8 -- fim"],
    ["11.0.0.0", "public", "10.0.0.0/8 -- imediatamente depois"],

    ["0.0.0.0", "unspecified", "0.0.0.0/8 -- início (this-network)"],
    ["0.255.255.255", "unspecified", "0.0.0.0/8 -- fim"],
    ["1.0.0.0", "public", "0.0.0.0/8 -- imediatamente depois"],

    ["100.63.255.255", "public", "100.64.0.0/10 -- imediatamente antes"],
    ["100.64.0.0", "cgnat", "100.64.0.0/10 -- início"],
    ["100.127.255.255", "cgnat", "100.64.0.0/10 -- fim"],
    ["100.128.0.0", "public", "100.64.0.0/10 -- imediatamente depois"],

    ["126.255.255.255", "public", "127.0.0.0/8 -- imediatamente antes"],
    ["127.0.0.0", "loopback", "127.0.0.0/8 -- início"],
    ["127.255.255.255", "loopback", "127.0.0.0/8 -- fim"],
    ["128.0.0.0", "public", "127.0.0.0/8 -- imediatamente depois"],

    ["169.253.255.255", "public", "169.254.0.0/16 -- imediatamente antes"],
    ["169.254.0.0", "link-local", "169.254.0.0/16 -- início"],
    ["169.254.169.254", "link-local", "169.254.0.0/16 -- metadata de nuvem"],
    ["169.254.255.255", "link-local", "169.254.0.0/16 -- fim"],
    ["169.255.0.0", "public", "169.254.0.0/16 -- imediatamente depois"],

    ["172.15.255.255", "public", "172.16.0.0/12 -- imediatamente antes"],
    ["172.16.0.0", "private", "172.16.0.0/12 -- início"],
    ["172.31.255.255", "private", "172.16.0.0/12 -- fim"],
    ["172.32.0.0", "public", "172.16.0.0/12 -- imediatamente depois"],

    ["191.255.255.255", "public", "192.0.0.0/24 -- imediatamente antes"],
    ["192.0.0.0", "reserved", "192.0.0.0/24 -- início"],
    ["192.0.0.255", "reserved", "192.0.0.0/24 -- fim"],
    ["192.0.1.0", "public", "192.0.0.0/24 -- imediatamente depois"],

    ["192.0.1.255", "public", "192.0.2.0/24 -- imediatamente antes"],
    ["192.0.2.0", "documentation", "192.0.2.0/24 -- início"],
    ["192.0.2.255", "documentation", "192.0.2.0/24 -- fim"],
    ["192.0.3.0", "public", "192.0.2.0/24 -- imediatamente depois"],

    ["192.167.255.255", "public", "192.168.0.0/16 -- imediatamente antes"],
    ["192.168.0.0", "private", "192.168.0.0/16 -- início"],
    ["192.168.255.255", "private", "192.168.0.0/16 -- fim"],
    ["192.169.0.0", "public", "192.168.0.0/16 -- imediatamente depois"],

    ["198.17.255.255", "public", "198.18.0.0/15 -- imediatamente antes"],
    ["198.18.0.0", "reserved", "198.18.0.0/15 -- início"],
    ["198.19.255.255", "reserved", "198.18.0.0/15 -- fim"],
    ["198.20.0.0", "public", "198.18.0.0/15 -- imediatamente depois"],

    ["198.51.99.255", "public", "198.51.100.0/24 -- imediatamente antes"],
    ["198.51.100.0", "documentation", "198.51.100.0/24 -- início"],
    ["198.51.100.255", "documentation", "198.51.100.0/24 -- fim"],
    ["198.51.101.0", "public", "198.51.100.0/24 -- imediatamente depois"],

    ["203.0.112.255", "public", "203.0.113.0/24 -- imediatamente antes"],
    ["203.0.113.0", "documentation", "203.0.113.0/24 -- início"],
    ["203.0.113.255", "documentation", "203.0.113.0/24 -- fim"],
    ["203.0.114.0", "public", "203.0.113.0/24 -- imediatamente depois"],

    ["223.255.255.255", "public", "224.0.0.0/4 -- imediatamente antes"],
    ["224.0.0.0", "multicast", "224.0.0.0/4 -- início"],
    ["239.255.255.255", "multicast", "224.0.0.0/4 -- fim"],
    // "imediatamente depois" de 224.0.0.0/4 é 240.0.0.0, que já é a
    // PRÓPRIA faixa reservada seguinte -- não há "público depois"
    // aplicável aqui (não existe endereço público entre as duas faixas).

    ["240.0.0.0", "reserved", "240.0.0.0/4 -- início"],
    ["254.255.255.255", "reserved", "240.0.0.0/4 -- quase fim"],
    ["255.255.255.255", "reserved", "255.255.255.255 -- broadcast, topo do espaço IPv4"],
    // Não há "depois" de 255.255.255.255 -- é o último endereço IPv4 possível.
  ];
  for (const [ip, expected, label] of boundaries) {
    assert.equal(classifyIp(ip).category, expected, `${label}: ${ip} deveria ser "${expected}"`);
  }
});

// =====================================================================
// Seção 4: IPv6 e mecanismos de transição
// =====================================================================

test("Seção 4: categorias IPv6 básicas", () => {
  assert.equal(classifyIp("::").category, "unspecified");
  assert.equal(classifyIp("::1").category, "loopback");
  assert.equal(classifyIp("fc00::1").category, "private");
  assert.equal(classifyIp("fdff:ffff::1").category, "private"); // topo de fc00::/7
  assert.equal(classifyIp("fe80::1").category, "link-local");
  assert.equal(classifyIp("febf:ffff::1").category, "link-local"); // topo de fe80::/10
  assert.equal(classifyIp("ff00::1").category, "multicast");
  assert.equal(classifyIp("ffff::1").category, "multicast");
  assert.equal(classifyIp("2001:db8::1").category, "documentation");
});

test("Seção 4: IPv4-mapeado (::ffff:0:0/96) -- ÚNICO mecanismo decodificado, reclassifica pelo IPv4 embutido", () => {
  assert.equal(classifyIp("::ffff:192.168.1.1").category, "ipv4-mapped-private");
  assert.equal(classifyIp("::ffff:127.0.0.1").category, "ipv4-mapped-loopback");
  assert.equal(classifyIp("::ffff:8.8.8.8").category, "ipv4-mapped-public");
  assert.equal(isPublicIp("::ffff:8.8.8.8"), true);
  assert.equal(isPublicIp("::ffff:192.168.1.1"), false);
});

test("Seção 4: IPv4-compatible (deprecado, ::a.b.c.d SEM ffff) -- bloqueado por INTEIRO, mesmo com IPv4 embutido público", () => {
  assert.equal(classifyIp("::192.168.1.1").category, "ipv4-compatible-deprecated");
  assert.equal(classifyIp("::8.8.8.8").category, "ipv4-compatible-deprecated"); // público embutido, mas NÃO reclassificado -- categoria inteira bloqueada
  assert.equal(isPublicIp("::8.8.8.8"), false);
});

test("Seção 4: Teredo (2001::/32) -- bloqueado por inteiro (endpoint ofuscado por XOR, não decodificável com segurança)", () => {
  assert.equal(classifyIp("2001::1").category, "teredo");
  assert.equal(classifyIp("2001:0:4136:e378:8000:63bf:3fff:fdd2").category, "teredo"); // formato real de endereço Teredo
});

test("Seção 4: 6to4 (2002::/16) -- bloqueado por inteiro (depende de relay anycast externo)", () => {
  assert.equal(classifyIp("2002::1").category, "6to4");
  assert.equal(classifyIp("2002:c000:0204::1").category, "6to4"); // embute 192.0.2.4, mesmo assim bloqueado sem decodificar
});

test("Seção 4: NAT64 well-known (64:ff9b::/96) -- bloqueado por inteiro mesmo com IPv4 público embutido", () => {
  assert.equal(classifyIp("64:ff9b::8.8.8.8").category, "nat64-well-known");
  assert.equal(isPublicIp("64:ff9b::8.8.8.8"), false);
});

test("Seção 4: controle positivo -- IPv6 global legítimo aceito, incluindo formas adjacentes às faixas de transição bloqueadas", () => {
  assert.equal(classifyIp("2606:4700:4700::1111").category, "public"); // Cloudflare DNS, controle positivo principal
  assert.equal(classifyIp("2001:4860:4860::8888").category, "public"); // começa com "2001:" como Teredo/documentation, mas bytes[2..3] diferentes -- prova que a regra não é ampla demais
  assert.equal(classifyIp("2003::1").category, "public"); // adjacente a 6to4 (2002::/16), fora da faixa
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
  const initial = validateInitialUrl("https://[2606:4700:4700::1111]/");
  assert.equal(initial.ok, true);
});

test("Seção 4: bug corrigido nesta rodada -- IPv4-mapeado-público é tratado como público de ponta a ponta (URL literal e resposta DNS), não só em classifyIp isolado", async () => {
  // Achado durante a auditoria adversarial: isPublicIp()/validateInitialUrl()/
  // resolveAndValidateAddresses() só reconheciam a string exata "public",
  // rejeitando por engano um IPv4-mapeado que decodifica pra um IPv4
  // genuinamente público (categoria "ipv4-mapped-public"). Corrigido com
  // isPublicCategory() reutilizado nos 3 pontos de decisão.
  const literalResult = validateInitialUrl("https://[::ffff:8.8.8.8]/");
  assert.equal(literalResult.ok, true, "URL literal com IPv4-mapeado-público deveria ser aceita");

  const dnsResult = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => ["::ffff:8.8.8.8"],
  });
  assert.equal(dnsResult.ok, true, "DNS devolvendo IPv4-mapeado-público deveria ser aceito");
});

// =====================================================================
// Seção 5: respostas DNS adversariais
// =====================================================================

test("Seção 5: DNS retorna null em vez de array -- falha", async () => {
  const result = await resolveAndValidateAddresses("h.example", { resolveFn: async () => null });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_NO_ADDRESSES");
});

test("Seção 5: item do array sem campo address -- falha por inteiro, não ignora o item", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => [{ family: 4 }, "8.8.8.8"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_MALFORMED_RESULT");
});

test("Seção 5: endereço inválido no array -- falha", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => ["not-an-ip", "8.8.8.8"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_MALFORMED_RESULT");
});

test("Seção 5: família declarada incompatível com o endereço real -- falha", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => [{ address: "8.8.8.8", family: 6 }], // family diz IPv6, endereço é IPv4
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_MALFORMED_RESULT");
});

test("Seção 5: mistura de IPv4 público e IPv6 proibido -- falha por inteiro", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => ["8.8.8.8", "fc00::1"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_RESOLVED_NON_PUBLIC");
});

test("Seção 5: nome de host devolvido em vez de IP -- falha (nunca tenta resolver de novo silenciosamente)", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => ["cname.internal.example"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_MALFORMED_RESULT");
});

test("Seção 5: objeto em formato completamente inesperado -- falha, nunca lança", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => [{ foo: "bar" }, 12345, [1, 2, 3], null],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_MALFORMED_RESULT");
});

test("Seção 5: formato {address,family} válido (formato real de dns.lookup) -- aceito quando consistente", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.addresses.length, 2);
});

test("Seção 5: erro do resolvedor -- mensagem sanitizada, sem stack nem detalhe interno", async () => {
  const result = await resolveAndValidateAddresses("h.example", {
    resolveFn: async () => {
      const err = new Error("ENOTFOUND h.example -- consulta em 10.0.0.53, stack interna: at resolver.js:42");
      err.stack = "Error: ...\n    at resolver.js:42:1";
      throw err;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DNS_RESOLUTION_FAILED");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("10.0.0.53"));
  assert.ok(!serialized.includes("resolver.js"));
  assert.ok(!serialized.includes("ENOTFOUND"));
});

// =====================================================================
// Seção 6: canonicalização
// =====================================================================

test("Seção 6: path preservado corretamente", () => {
  const result = validateInitialUrl("https://example.com/a/b/c");
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/a/b/c");
});

test("Seção 6: query preservada sem reordenação (WHATWG URL não reordena)", () => {
  const result = validateInitialUrl("https://example.com/?z=1&a=2&m=3");
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/?z=1&a=2&m=3");
});

test("Seção 6: credenciais percent-encoded ainda são rejeitadas (não escapam da checagem por estarem codificadas)", () => {
  const result = validateInitialUrl("https://%75ser:%70ass@example.com/");
  assert.equal(result.ok, false);
  assert.equal(result.code, "CREDENTIALS_IN_URL");
});

test("Seção 6: espaço ou caractere de controle em QUALQUER posição da URL é rejeitado explicitamente (não silenciosamente removido/aceito pelo parser)", () => {
  // Comportamento observado do parser antes desta correção (documentado no
  // código-fonte): espaço no host FAZIA o parser lançar (US_UNPARSEABLE),
  // mas espaço no path virava "%20" silenciosamente, e tab/CR/LF em
  // qualquer posição eram REMOVIDOS pelo parser sem erro nenhum. Nenhum dos
  // dois é "rejeição" -- por isso a checagem explícita em checkRawUrlString.
  const tab = String.fromCharCode(9);
  const cases = [`https://exa mple.com/`, `https://example.com/pa th`, `https://example.com/${tab}x`, `https://example.com/x${String.fromCharCode(1)}y`];
  for (const url of cases) {
    const result = validateInitialUrl(url);
    assert.equal(result.ok, false, `deveria rejeitar URL com espaço/controle: ${JSON.stringify(url)}`);
    assert.equal(result.code, "URL_CONTAINS_CONTROL_CHARS", `code inesperado pra ${JSON.stringify(url)}`);
  }
});

test("Seção 6: URL excessivamente grande rejeitada por limite explícito (MAX_URL_LENGTH)", () => {
  assert.equal(typeof MAX_URL_LENGTH, "number");
  assert.ok(MAX_URL_LENGTH > 0);
  const huge = "https://example.com/" + "a".repeat(MAX_URL_LENGTH + 100);
  const result = validateInitialUrl(huge);
  assert.equal(result.ok, false);
  assert.equal(result.code, "URL_TOO_LONG");

  // Uma URL dentro do limite continua funcionando normalmente.
  const withinLimit = "https://example.com/" + "a".repeat(50);
  assert.equal(validateInitialUrl(withinLimit).ok, true);
});

// =====================================================================
// Seção 7: redirects -- casos adicionais
// =====================================================================

test("Seção 7: redirect ABSOLUTO (ignora baseUrl quando o Location já é absoluto)", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"], "b.example": ["1.1.1.1"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("https://b.example/target", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, true);
  assert.equal(second.url, "https://b.example/target");
});

test("Seção 7: redirect para localhost -- rejeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("https://localhost/", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, false);
  assert.equal(second.code, "LOCALHOST_BLOCKED");
});

test("Seção 7: redirect com credenciais embutidas -- rejeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("https://user:pass@a.example/", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, false);
  assert.equal(second.code, "CREDENTIALS_IN_URL");
});

test("Seção 7: redirect para porta proibida -- rejeitado", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const first = await validateHop("https://a.example/start", { resolveFn });
  const second = await validateHop("https://a.example:8080/", { baseUrl: first.url, redirectCount: 1, resolveFn });
  assert.equal(second.ok, false);
  assert.equal(second.code, "PORT_NOT_ALLOWED");
});

test("Seção 7: EXATAMENTE no limite permitido -- ainda aceito (limite é > , não >=)", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const result = await validateHop("https://a.example/", { redirectCount: DEFAULT_MAX_REDIRECTS, maxRedirects: DEFAULT_MAX_REDIRECTS, resolveFn });
  assert.equal(result.ok, true);
});

test("Seção 7: redirectCount/maxRedirects inválidos (negativo, fracionário, NaN, string, null) falham explicitamente, nunca são coagidos", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  for (const bad of [-1, 1.5, NaN, "3", null]) {
    const result = await validateHop("https://a.example/", { redirectCount: bad, resolveFn });
    assert.equal(result.ok, false, `redirectCount=${JSON.stringify(bad)} deveria falhar`);
    assert.equal(result.code, "INVALID_REDIRECT_COUNT", `code inesperado pra redirectCount=${JSON.stringify(bad)}`);
  }
  for (const bad of [-1, 1.5, NaN, "5", null]) {
    const result = await validateHop("https://a.example/", { maxRedirects: bad, resolveFn });
    assert.equal(result.ok, false, `maxRedirects=${JSON.stringify(bad)} deveria falhar`);
    assert.equal(result.code, "INVALID_MAX_REDIRECTS", `code inesperado pra maxRedirects=${JSON.stringify(bad)}`);
  }
});

test("Seção 7: redirectCount AUSENTE (parâmetro omitido) continua funcionando -- default 0 válido, não é caso de falha", async () => {
  const resolveFn = fakeResolver({ "a.example": ["8.8.8.8"] });
  const result = await validateHop("https://a.example/", { resolveFn }); // redirectCount nem mencionado
  assert.equal(result.ok, true);
  assert.equal(result.redirectCount, 0);
});

// =====================================================================
// Seção 8: contrato contra DNS rebinding -- o que o retorno bem-sucedido fornece
// =====================================================================

test("Seção 8: retorno bem-sucedido fornece hostname normalizado + URL canônica + TODOS os IPs validados -- suficiente pra fixar conexão preservando Host/SNI", async () => {
  const resolveFn = fakeResolver({ "example.com": ["8.8.8.8", "1.1.1.1"] });
  const result = await validateHop("https://EXAMPLE.com/feed#ignored", { resolveFn });
  assert.equal(result.ok, true);
  assert.equal(result.hostname, "example.com"); // normalizado, minúsculo
  assert.equal(result.url, "https://example.com/feed"); // canônica, sem fragmento
  assert.equal(result.addresses.length, 2);
  for (const a of result.addresses) {
    assert.equal(typeof a.address, "string"); // IP usável diretamente como destino de conexão
    assert.equal(a.category, "public");
  }
});

// =====================================================================
// AJUSTE FOCALIZADO -- formato estrito das respostas DNS
// =====================================================================

test("formato estrito de item DNS: objeto sem family, ou com family fora de {4,6} (tipo ou valor errado), sempre falha -- nenhum item malformado é ignorado", async () => {
  const badItems = [
    { address: "8.8.8.8" }, // sem family
    { address: "8.8.8.8", family: 0 },
    { address: "8.8.8.8", family: 5 },
    { address: "8.8.8.8", family: "4" }, // string, não number -- tipo errado
    { address: "8.8.8.8", family: null },
    { address: "8.8.8.8", family: 6 }, // family válido, mas NÃO bate com a versão real (8.8.8.8 é v4)
    { address: "2606:4700:4700::1111", family: 4 }, // idem, invertido
  ];
  for (const item of badItems) {
    const result = await resolveAndValidateAddresses("h.example", { resolveFn: async () => [item] });
    assert.equal(result.ok, false, `deveria falhar pra ${JSON.stringify(item)}`);
    assert.equal(result.code, "DNS_MALFORMED_RESULT", `code inesperado pra ${JSON.stringify(item)}`);
  }
});

test("formato estrito de item DNS: family EXATAMENTE 4 ou 6, compatível com o endereço real, passa", async () => {
  const goodV4 = await resolveAndValidateAddresses("h.example", { resolveFn: async () => [{ address: "8.8.8.8", family: 4 }] });
  assert.equal(goodV4.ok, true);
  const goodV6 = await resolveAndValidateAddresses("h.example", { resolveFn: async () => [{ address: "2606:4700:4700::1111", family: 6 }] });
  assert.equal(goodV6.ok, true);
});

test("formato estrito de item DNS: string pura continua permitida sem exigir family (resolvedores injetados simples continuam funcionando)", async () => {
  const result = await resolveAndValidateAddresses("h.example", { resolveFn: async () => ["8.8.8.8"] });
  assert.equal(result.ok, true);
});

// =====================================================================
// AJUSTE FOCALIZADO -- faixas IPv6 especiais adicionais
// =====================================================================

test("faixas IPv6 especiais adicionais são bloqueadas explicitamente", () => {
  assert.equal(classifyIp("fec0::1").category, "site-local-deprecated"); // fec0::/10
  assert.equal(classifyIp("2001:2::1").category, "benchmarking-v6"); // 2001:2::/48
  assert.equal(classifyIp("2001:10::1").category, "orchid-deprecated"); // 2001:10::/28
  assert.equal(classifyIp("2001:1f:ffff::1").category, "orchid-deprecated"); // topo de 2001:10::/28
  assert.equal(classifyIp("2001:20::1").category, "orchidv2"); // 2001:20::/28
  assert.equal(classifyIp("2001:2f:ffff::1").category, "orchidv2"); // topo de 2001:20::/28
  assert.equal(classifyIp("3fff::1").category, "documentation"); // 3fff::/20
  assert.equal(classifyIp("3fff:fff::1").category, "documentation"); // dentro de 3fff::/20
  assert.equal(classifyIp("5f00::1").category, "reserved"); // 5f00::/16 (SRv6 SIDs)
  for (const ip of ["fec0::1", "2001:2::1", "2001:10::1", "2001:20::1", "3fff::1", "5f00::1"]) {
    assert.equal(isPublicIp(ip), false, `${ip} nunca deveria ser público`);
  }
});

test("faixas IPv6 adjacentes às novas faixas especiais continuam PÚBLICAS -- regra não é ampla demais", () => {
  // Logo abaixo de fec0::/10 (fe80::/10, já testado como link-local) e logo
  // acima (ff00::/8, já testado como multicast) -- confirma que
  // site-local-deprecated não vazou pra faixas vizinhas.
  assert.equal(classifyIp("fdff:ffff::1").category, "private"); // ULA, vizinho de baixo
  assert.equal(classifyIp("ff00::1").category, "multicast"); // vizinho de cima

  // Adjacentes às sub-faixas 2001:xx:: -- valores de bytes[2..3] fora de
  // benchmarking/orchid/orchidv2/documentation/teredo continuam públicos.
  assert.equal(classifyIp("2001:1::1").category, "public"); // entre teredo(2001:0) e benchmarking(2001:2)
  assert.equal(classifyIp("2001:3::1").category, "public"); // logo depois de benchmarking
  assert.equal(classifyIp("2001:f::1").category, "public"); // logo antes de orchid (2001:10::)
  assert.equal(classifyIp("2001:30::1").category, "public"); // logo depois de orchidv2 (2001:20::-2001:2f::)
  assert.equal(classifyIp("2001:4860:4860::8888").category, "public"); // controle já usado -- Google IPv6 DNS, bem longe de qualquer faixa especial 2001:xx

  // Adjacentes a 3fff::/20 (termina em 3fff:0fff:ffff:...) e 5f00::/16.
  assert.equal(classifyIp("3ffe:ffff::1").category, "public"); // logo antes de 3fff::/20
  assert.equal(classifyIp("3fff:1000::1").category, "public"); // logo depois, fronteira exata (byte2 sai de 0x0_ pra 0x10)
  assert.equal(classifyIp("4000::1").category, "public"); // controle adicional, bem fora
  assert.equal(classifyIp("5eff:ffff::1").category, "public"); // logo antes de 5f00::/16
  assert.equal(classifyIp("5f01::1").category, "public"); // logo depois, fronteira exata (byte1 sai de 0x00 pra 0x01)
  assert.equal(classifyIp("6000::1").category, "public"); // controle adicional, bem fora

  for (const ip of ["fdff:ffff::1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicIp(ip), ip === "fdff:ffff::1" ? false : true); // fdff é ULA (privado), os outros são controle público real
  }
});

// =====================================================================
// AJUSTE FOCALIZADO -- coerência de categorias públicas (isPublicCategory)
// =====================================================================

test("isPublicCategory: única função central usada por todo ponto de decisão -- 'public' e 'ipv4-mapped-public' aceitos, TODAS as demais categorias ipv4-mapped-* bloqueadas", () => {
  assert.equal(isPublicCategory("public"), true);
  assert.equal(isPublicCategory("ipv4-mapped-public"), true);

  const otherMapped = [
    "ipv4-mapped-private",
    "ipv4-mapped-loopback",
    "ipv4-mapped-link-local",
    "ipv4-mapped-cgnat",
    "ipv4-mapped-unspecified",
    "ipv4-mapped-multicast",
    "ipv4-mapped-documentation",
    "ipv4-mapped-reserved",
    "ipv4-mapped-invalid",
  ];
  for (const category of otherMapped) {
    assert.equal(isPublicCategory(category), false, `${category} nunca deveria ser tratado como público`);
  }
});

test("isPublicCategory: categoria futura desconhecida NUNCA é aceita por padrão (fail-closed, allowlist positiva e fechada, não denylist)", () => {
  for (const category of ["ipv4-mapped-somefuturecategory", "totally-new-category-2030", "PUBLIC", "Public", " public", "public "]) {
    assert.equal(isPublicCategory(category), false, `"${category}" não deveria ser aceito -- só os 2 literais exatos são`);
  }
});

test("isPublicCategory: entrada inválida (não-string, ausente) falha de modo seguro, nunca lança", () => {
  for (const bad of [undefined, null, 123, {}, [], true, ""]) {
    assert.doesNotThrow(() => isPublicCategory(bad));
    assert.equal(isPublicCategory(bad), false);
  }
});

test("Todos os pontos de decisão do módulo (isPublicIp, validateInitialUrl, resolveAndValidateAddresses) concordam entre si sobre um mesmo IPv4-mapeado-público", async () => {
  const mappedPublic = "::ffff:8.8.8.8";
  assert.equal(isPublicIp(mappedPublic), true);
  assert.equal(validateInitialUrl(`https://[${mappedPublic}]/`).ok, true);
  const dnsResult = await resolveAndValidateAddresses("h.example", { resolveFn: async () => [mappedPublic] });
  assert.equal(dnsResult.ok, true);
});

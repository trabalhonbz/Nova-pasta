/* Primitivas de senha, sessao e comparacao do Worker NBZ.

   POR QUE O HASH E EM DUAS ETAPAS

   O desenho de livro guarda PBKDF2 calculado no servidor. Nao cabe aqui: o
   plano gratuito do Workers da 10 ms de CPU por request, e PBKDF2-SHA256
   custa 19 ms com 50 mil iteracoes e 75 ms com 210 mil. Qualquer login
   estouraria o limite e voltaria erro.

   O que se faz no lugar:

     navegador:  clientHash = PBKDF2-SHA256(senha, salt, iteracoes)
     servidor:   guardado   = HMAC-SHA256(PEPPER, clientHash)

   O KDF lento fica no cliente — que e onde o painel ja roda PBKDF2 hoje — e o
   servidor so aplica um HMAC de 1 ms com um segredo que nunca entra no banco.

   O que isso garante e o que nao garante:

   - vazamento do D1 sozinho nao abre nenhuma conta: o atacante teria o HMAC,
     mas para entrar precisa enviar o clientHash, e deriva-lo exige a senha;
   - vazamento do D1 MAIS do PEPPER volta ao caso normal de forca bruta ao
     custo do PBKDF2;
   - o clientHash trafega no lugar da senha. Sob HTTPS isso equivale a enviar a
     senha; quem interceptar um dos dois entra. Por isso o Worker recusa
     requisicao que nao seja https.

   Para ter PBKDF2 no servidor, o caminho e o plano pago do Workers (US$5/mes,
   30 s de CPU) — e so trocar `verificarSenha` por uma derivacao direta.
*/

const codificador = new TextEncoder();

export const ITERACOES_PADRAO = 210000;
export const TAMANHO_SALT = 16;
export const VALIDADE_SESSAO_HORAS = 12;

/* ------------------------------------------------------------ utilitarios */

export function paraHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function deHex(texto) {
  const limpo = String(texto || '').trim();
  if (limpo.length % 2 !== 0 || /[^0-9a-f]/i.test(limpo)) return null;
  const bytes = new Uint8Array(limpo.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(limpo.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesAleatorios(tamanho) {
  return crypto.getRandomValues(new Uint8Array(tamanho));
}

export function novoId() {
  return crypto.randomUUID();
}

/* Comparacao de tempo constante. Um `===` em string vaza o tamanho do prefixo
   igual pelo tempo de execucao, e com isso um token pode ser descoberto byte a
   byte. Compara-se o XOR acumulado de todos os bytes, sempre ate o fim. */
export function iguaisEmTempoConstante(a, b) {
  const x = codificador.encode(String(a || ''));
  const y = codificador.encode(String(b || ''));
  /* Tamanhos diferentes ja nao batem, mas ainda se percorre o maior para nao
     transformar o proprio tamanho num canal de tempo. */
  let diferenca = x.length === y.length ? 0 : 1;
  const limite = Math.max(x.length, y.length);
  for (let i = 0; i < limite; i += 1) {
    diferenca |= (x[i] || 0) ^ (y[i] || 0);
  }
  return diferenca === 0;
}

/* ------------------------------------------------------------------- hash */

export async function sha256Hex(texto) {
  const resumo = await crypto.subtle.digest('SHA-256', codificador.encode(String(texto)));
  return paraHex(resumo);
}

async function chaveHmac(segredo) {
  return crypto.subtle.importKey(
    'raw',
    codificador.encode(String(segredo)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function hmacHex(segredo, mensagem) {
  const chave = await chaveHmac(segredo);
  const assinatura = await crypto.subtle.sign('HMAC', chave, codificador.encode(String(mensagem)));
  return paraHex(assinatura);
}

/* ------------------------------------------------------------------ senha */

/* O clientHash chega em hex de 64 caracteres (256 bits do PBKDF2). Recusar
   qualquer outro formato impede que um cliente mande a senha crua por engano e
   ela acabe guardada como se fosse hash. */
export function clientHashValido(valor) {
  return typeof valor === 'string' && /^[0-9a-f]{64}$/i.test(valor);
}

export async function protegerSenha(pepper, clientHash) {
  if (!clientHashValido(clientHash)) throw new Error('clientHash em formato invalido.');
  return hmacHex(pepper, clientHash.toLowerCase());
}

export async function verificarSenha(pepper, clientHash, guardado) {
  if (!clientHashValido(clientHash)) return false;
  const calculado = await protegerSenha(pepper, clientHash);
  return iguaisEmTempoConstante(calculado, guardado);
}

export function novoSalt() {
  return paraHex(bytesAleatorios(TAMANHO_SALT));
}

/* Salt de fachada para usuario inexistente.

   O cliente precisa do salt antes de autenticar, para calcular o PBKDF2. Se o
   servidor respondesse "nao existe", qualquer um listaria os usuarios da
   empresa testando nomes. Devolve-se um salt deterministico derivado do nome
   com o pepper: estavel entre chamadas (como o de um usuario real) e
   indistinguivel de um salt de verdade. */
export async function saltDeFachada(pepper, usuario) {
  const derivado = await hmacHex(pepper, `fachada:${String(usuario).toLowerCase()}`);
  return derivado.slice(0, TAMANHO_SALT * 2);
}

/* ---------------------------------------------------------------- sessoes */

/* 32 bytes de entropia. O token em claro vai para o cliente e nunca e gravado;
   o banco guarda so o SHA-256 dele, para que vazamento da tabela de sessoes
   nao permita assumir sessao nenhuma. */
export async function novoToken() {
  const bruto = paraHex(bytesAleatorios(32));
  return { token: bruto, hash: await sha256Hex(bruto) };
}

export function expiracaoSessao(horas = VALIDADE_SESSAO_HORAS) {
  return new Date(Date.now() + horas * 3600 * 1000).toISOString();
}

export function agora() {
  return new Date().toISOString();
}

export function expirou(iso) {
  if (!iso) return true;
  const quando = Date.parse(iso);
  return !Number.isFinite(quando) || quando <= Date.now();
}

/* Harness de testes do Painel NBZ.

   O painel é um arquivo único (index.html) que roda inteiramente no navegador, sem
   servidor nem API. Para testá-lo fora do navegador, carregamos o próprio index.html
   em jsdom e dirigimos a interface de verdade: preenchemos campos, disparamos submit
   e lemos o que ficou no localStorage.

   Dois ajustes são indispensáveis e explicam quase todo o código daqui:

   - `window.crypto` do jsdom não tem `.subtle` e é um acessor, então uma atribuição
     simples é ignorada: precisa de `defineProperty`. Sem isso o painel cai no hash
     de reserva e os testes de senha passariam a medir o algoritmo errado.
   - `TextEncoder` precisa ser o do Node. O do jsdom devolve Uint8Array de outro
     realm, que o `crypto.subtle` rejeita — de novo mascarando o PBKDF2.
   - O jsdom não implementa nenhum método de `<dialog>`, e o painel abre quase tudo em
     diálogo (planta, fotos, setores, usuários). Sem o shim abaixo, qualquer teste que
     abra um diálogo falha com "showModal is not a function".
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM, VirtualConsole } from 'jsdom';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
/* NBZ_INDEX aponta a suíte para outra cópia do painel — é como se confere que um
   teste de correção realmente falha na versão anterior. */
export const indexPath = process.env.NBZ_INDEX || path.join(testsDir, '..', 'index.html');

/* Sobe uma instância do painel.
   `comCryptoSubtle: false` simula navegador antigo ou origem não segura (http:// de
   rede local, arquivo aberto do disco), onde `crypto.subtle` não existe. */
export async function boot({ query = '', seed = null, comCryptoSubtle = true } = {}) {
  const html = fs.readFileSync(indexPath, 'utf8')
    /* As bibliotecas de CDN (pdf.js, xlsx) não são baixadas no teste: o painel já
       trata a ausência delas, e depender da rede tornaria a suíte instável. */
    .replace(/<script src="https:\/\/[^"]*"><\/script>/g, '');

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error.message}`));

  const dom = new JSDOM(html, {
    url: `http://localhost/index.html${query}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', {
        configurable: true,
        writable: true,
        value: comCryptoSubtle
          ? globalThis.crypto
          : { getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes) }
      });
      window.TextEncoder = globalThis.TextEncoder;
      window.TextDecoder = globalThis.TextDecoder;
      instalarShimDeDialogo(window);
      window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
      window.cancelAnimationFrame = (id) => clearTimeout(id);
      window.scrollTo = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
      if (seed) for (const [key, value] of Object.entries(seed)) window.localStorage.setItem(key, value);
    }
  });

  await pausa(120);
  const contexto = {
    dom,
    window: dom.window,
    doc: dom.window.document,
    errors,
    /* Lê e escreve no escopo do painel. As variáveis de estado são `const`/`let` no
       topo do script, então não ficam no window — só um eval indireto as alcança. */
    eval: (code) => dom.window.eval(code),
    submit: (seletor) => dom.window.document.querySelector(seletor)
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    fechar: () => dom.window.close()
  };
  return contexto;
}

/* O jsdom reconhece o elemento `<dialog>` mas não traz `show`, `showModal` nem `close`.
   O shim cobre o que o painel usa: alternar `open` e disparar o evento `close`, que o
   painel escuta para limpar o estado do editor de setores. */
function instalarShimDeDialogo(window) {
  const proto = window.HTMLDialogElement?.prototype;
  if (!proto || typeof proto.showModal === 'function') return;
  const abrir = function abrir() { this.open = true; };
  proto.show = abrir;
  proto.showModal = abrir;
  proto.close = function close(valor) {
    if (!this.open) return;
    this.open = false;
    if (valor !== undefined) this.returnValue = valor;
    this.dispatchEvent(new window.Event('close'));
  };
}

export function pausa(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* O primeiro acesso de cada ambiente exige cadastrar o administrador; quase todo
   teste precisa de uma sessão aberta antes de chegar ao que quer verificar. */
export async function criarAdministrador(ctx, { senha = 'senhaforte1', usuario = 'andre.mendonca' } = {}) {
  ctx.doc.querySelector('#setupName').value = 'Andre Mendonca';
  ctx.doc.querySelector('#setupUser').value = usuario;
  ctx.doc.querySelector('#setupPassword').value = senha;
  ctx.doc.querySelector('#setupPasswordConfirm').value = senha;
  ctx.submit('#authSetupForm');
  /* PBKDF2 com 150 000 iterações não é instantâneo. */
  await pausa(1200);
  return ctx.doc.querySelector('#appShell').hidden === false;
}

export async function entrar(ctx, { usuario = 'andre.mendonca', senha = 'senhaforte1' } = {}) {
  ctx.doc.querySelector('#loginUser').value = usuario;
  ctx.doc.querySelector('#loginPassword').value = senha;
  ctx.submit('#authLoginForm');
  await pausa(1200);
  return ctx.doc.querySelector('#appShell').hidden === false;
}

/* Faz a chave indicada recusar gravação, como um localStorage com a cota cheia.
   Devolve a função que restaura o comportamento normal. */
export function esgotarCota(ctx, chave) {
  const proto = Object.getPrototypeOf(ctx.window.localStorage);
  const original = proto.setItem;
  proto.setItem = function setItem(key, value) {
    if (key === chave) {
      const erro = new Error('QuotaExceededError');
      erro.name = 'QuotaExceededError';
      throw erro;
    }
    return original.call(this, key, value);
  };
  return () => { proto.setItem = original; };
}

/* Faz a chave aceitar gravação apenas até um tamanho, como um localStorage perto do
   limite: é o cenário em que o corte do histórico precisa servir de alívio.
   Devolve a função que restaura o comportamento normal. */
export function limitarCota(ctx, chave, maximoBytes) {
  const proto = Object.getPrototypeOf(ctx.window.localStorage);
  const original = proto.setItem;
  proto.setItem = function setItem(key, value) {
    if (key === chave && String(value).length > maximoBytes) {
      const erro = new Error('QuotaExceededError');
      erro.name = 'QuotaExceededError';
      throw erro;
    }
    return original.call(this, key, value);
  };
  return () => { proto.setItem = original; };
}

/* ---- mini framework de asserções ---- */
const casos = [];
export function teste(nome, fn) { casos.push({ nome, fn }); }

export function confirmar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem || 'asserção falhou');
}

export function igual(obtido, esperado, mensagem) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${mensagem || 'valor inesperado'} — esperado ${b}, recebido ${a}`);
}

export async function executar(titulo) {
  console.log(`\n${titulo}\n${'='.repeat(titulo.length)}`);
  let passaram = 0;
  const falhas = [];
  for (const { nome, fn } of casos) {
    try {
      await fn();
      console.log(`  ok    ${nome}`);
      passaram += 1;
    } catch (erro) {
      console.log(`  FALHA ${nome}\n          ${erro.message}`);
      falhas.push(nome);
    }
  }
  console.log(`\n${passaram} passaram, ${falhas.length} falharam`);
  if (falhas.length) {
    console.log(`Falhas: ${falhas.join('; ')}`);
    process.exitCode = 1;
  }
  /* O painel mantém intervalos ativos (bloqueio do histórico, sessão inativa), então
     o processo não encerraria sozinho. */
  process.exit(falhas.length ? 1 : 0);
}

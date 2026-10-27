/* Harness de testes do Painel NBZ.

   O painel é uma página (index.html) com os estilos em src/estilos/ e os scripts em
   src/, e roda inteiramente no navegador. Para testá-lo fora do navegador, carregamos
   o próprio index.html em jsdom e dirigimos a interface de verdade: preenchemos
   campos, disparamos submit e lemos o que ficou no localStorage.

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
import { IDBFactory } from 'fake-indexeddb';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
/* NBZ_INDEX aponta a suíte para outra cópia do painel — é como se confere que um
   teste de correção realmente falha na versão anterior. */
export const indexPath = process.env.NBZ_INDEX || path.join(testsDir, '..', 'index.html');

/* Devolve todo o CSS do painel, na ordem exata em que o index.html o carrega.

   Serve a testes que conferem a presença de uma regra — caso da folha A4, que o jsdom
   não sabe calcular. O texto vem compactado (sem comentários, sem espaço em volta de
   `{`, `}` e `;`) justamente para que esses testes falem sobre a regra e não sobre a
   formatação do arquivo: reindentar um CSS não deve quebrar teste nenhum.

   De quebra, isto confere que cada <link rel="stylesheet"> aponta para um arquivo que
   existe de verdade — a leitura falha se o caminho estiver errado. */
export function estilosDoPainel() {
  const html = fs.readFileSync(indexPath, 'utf8');
  const arquivos = [...html.matchAll(/<link rel="stylesheet" href="(src\/[^"]+)">/g)].map(([, arquivo]) => arquivo);
  if (!arquivos.length) throw new Error('o index.html não aponta nenhuma folha de estilo em src/');
  const css = arquivos
    .map((arquivo) => fs.readFileSync(path.join(testsDir, '..', arquivo), 'utf8'))
    .join('\n');
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};]) ?/g, '$1')
    .trim();
}

/* Sobe uma instância do painel.
   `comCryptoSubtle: false` simula navegador antigo ou origem não segura (http:// de
   rede local, arquivo aberto do disco), onde `crypto.subtle` não existe. */
/* `api` liga o painel a um servidor. Recebe `{ endereco, atender }`, onde
   `atender(Request)` devolve uma Response — na prática, o `fetch` do Worker de
   verdade com D1 em memória (ver tests/integracao.test.js). Sem ele o painel
   roda no modo local, que é o estado de antes de existir API. */
export async function boot({
  query = '', seed = null, comCryptoSubtle = true, comIndexedDB = true, api = null
} = {}) {
  const html = fs.readFileSync(indexPath, 'utf8')
    /* As bibliotecas de CDN (pdf.js, xlsx) não são baixadas no teste: o painel já
       trata a ausência delas, e depender da rede tornaria a suíte instável. */
    .replace(/<script src="https:\/\/[^"]*"><\/script>/g, '')
    /* Os scripts locais, ao contrário, são indispensáveis e precisam ser
       embutidos: sem `resources: 'usable'` o jsdom ignora `src` relativo, e o
       painel abriria sem a camada de mídia nem o cliente da API. Embutir em vez
       de ligar o carregamento de recursos mantém a suíte sem acesso a rede. */
    .replace(
      /<script src="(src\/[^"]+)"><\/script>/g,
      (_, arquivo) => `<script>${fs.readFileSync(path.join(testsDir, '..', arquivo), 'utf8')}</script>`
    )
    /* As folhas de estilo entram pelo mesmo motivo, e não só por capricho: há
       teste que confere exibição por estilo calculado, porque `.sketch-tools`
       declara `display:flex` e precisa vencer o `display:none` do atributo
       [hidden]. Sem embutir o CSS, esse teste passaria por outro caminho — o
       estilo padrão do jsdom — e pararia de medir a regra que existe para
       isso. */
    .replace(
      /<link rel="stylesheet" href="(src\/[^"]+)">/g,
      (_, arquivo) => `<style>${fs.readFileSync(path.join(testsDir, '..', arquivo), 'utf8')}</style>`
    )
    /* Define a meta que liga o painel ao servidor.

       O padrão `content="[^"]*"` casa com QUALQUER valor, de propósito: o
       endereço gravado no arquivo é conveniência de quem desenvolve e muda com
       frequência. Se o teste dependesse de ele estar vazio, deixar um endereço
       local salvo faria a suíte inteira bootar em modo remoto contra uma porta
       que não existe no jsdom — que foi exatamente o que aconteceu. */
    .replace(
      /<meta name="nbz-api" content="[^"]*">/,
      `<meta name="nbz-api" content="${api ? api.endereco : ''}">`
    );

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
      /* O shim precisa entrar ANTES do script do painel: a camada de mídia
         guarda em cache se o IndexedDB existe na primeira consulta, e remover o
         `indexedDB` depois do arranque não desfaz esse cache. Por isso simular
         modo privado é opção de boot, e não algo que o teste faça depois. */
      instalarShimDeMidia(window, comIndexedDB);
      if (api) instalarFetchDoWorker(window, api);
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

/* IndexedDB e object URL para o painel.

   As fotografias saíram do localStorage e passaram a morar no IndexedDB como
   binário, com `photo.data` guardando um object URL. O jsdom não implementa
   nenhum dos dois: `window.indexedDB` é undefined e `URL.createObjectURL` não
   existe. Sem estes substitutos o painel cairia no modo de reserva em base64 e
   a suíte deixaria de exercitar o caminho que roda no navegador.

   A URL devolvida é sintética. O que se verifica fora do navegador é que a
   referência certa chega ao `<img src>`; se a imagem aparece continua sendo
   conferência manual. */
function instalarShimDeMidia(window, comIndexedDB = true) {
  /* `comIndexedDB: false` reproduz modo privado de alguns navegadores e origem
     não segura, onde o painel tem de voltar ao base64 em vez de falhar. */
  window.indexedDB = comIndexedDB ? new IDBFactory() : undefined;

  const blobsPorUrl = new Map();
  let sequencia = 0;
  window.URL.createObjectURL = (blob) => {
    sequencia += 1;
    const url = `blob:http://localhost/foto-${sequencia}`;
    blobsPorUrl.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = (url) => { blobsPorUrl.delete(url); };
  /* Exposto para os testes conferirem vazamento de object URL. */
  window.__urlsDeBlobVivas = () => blobsPorUrl.size;
}

/* Entrega as chamadas do painel ao Worker, sem rede no meio.

   O jsdom não tem `fetch`, e o Worker é só uma função que recebe Request e
   devolve Response — as duas classes existem no Node. Então o caminho inteiro é
   exercitado de verdade: formulário do painel -> src/api.js -> roteador do
   Worker -> D1. O que não se cobre é a rede e o limite de CPU do Worker.

   A Response volta embrulhada porque o `src/api.js` lê `.headers.get` e
   `.json()`, e objeto de outro realm atravessa o jsdom sem problema desde que a
   interface seja essa. */
function instalarFetchDoWorker(window, api) {
  window.fetch = async (url, opcoes = {}) => {
    /* Blob do jsdom não atravessa para o Request do Node: ele é serializado
       como o texto "[object Blob]", e o upload chegaria ao Worker com 13 bytes
       de lixo em vez da imagem — que o `tipoReal()` recusa com 415, como deve.
       No navegador isso não acontece; aqui os bytes são lidos antes. */
    let corpoEnviado = opcoes.body ?? undefined;
    if (corpoEnviado && typeof corpoEnviado.arrayBuffer === 'function') {
      corpoEnviado = new Uint8Array(await corpoEnviado.arrayBuffer());
    }

    /* Resolve endereço relativo contra a página, como o navegador faz.

       Com o painel servido pelo próprio Worker, a base da API é vazia e as
       chamadas saem como `/saude`. O `Request` do Node exige URL absoluta e
       lançaria "Invalid URL" — não porque o painel esteja errado, mas porque o
       harness não fazia a resolução que o navegador faz sozinho. Endereço
       absoluto passa intacto: o segundo argumento do `URL` só vale como base
       quando o primeiro é relativo. */
    const absoluta = new URL(String(url), window.location.href).toString();

    const pedido = new Request(absoluta, {
      method: opcoes.method || 'GET',
      headers: opcoes.headers || {},
      body: corpoEnviado
    });
    const resposta = await api.atender(pedido);
    /* O corpo é lido como bytes, e não como texto: as rotas de fotografia
       devolvem JPEG, e `text()` o corromperia na decodificação. Texto e JSON
       saem dos mesmos bytes, decodificados sob demanda. */
    const bytes = await resposta.arrayBuffer();
    const comoTexto = () => new TextDecoder().decode(bytes);
    return {
      ok: resposta.ok,
      status: resposta.status,
      headers: { get: (nome) => resposta.headers.get(nome) },
      arrayBuffer: async () => bytes,
      text: async () => comoTexto(),
      json: async () => JSON.parse(comoTexto() || '{}')
    };
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

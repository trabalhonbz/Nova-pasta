/* Monta a pasta `site/`, que e o que o Worker publica como arquivo estatico.

   POR QUE ESTA PASTA EXISTE EM VEZ DE PUBLICAR A RAIZ

   O `[assets]` do wrangler publica um diretorio INTEIRO, e a raiz do projeto
   contem `.pepper-producao.txt`, `.dev.vars`, `src/worker/`, os testes e o
   `node_modules`. Apontar o `directory` para a raiz colocaria o segredo que
   protege todas as senhas num endereco publico.

   Da para excluir arquivo com `.assetsignore`, mas isso e lista de EXCLUSAO: um
   arquivo sensivel novo vaza por omissao, e o erro so aparece depois de
   publicado. Aqui a logica e invertida — nada entra sem estar referenciado.

   COMO A LISTA E DERIVADA

   Do proprio `index.html`: cada `href`/`src` que aponta para arquivo local do
   projeto. Assim, acrescentar uma folha de estilo em `src/estilos/` passa a
   funcionar sozinho, sem ninguem lembrar de editar este script — que e
   exatamente o tipo de esquecimento que deixaria o painel no ar com CSS
   faltando.

   Mais os quatro que o navegador busca sem o HTML os citar: o proprio
   `index.html`, o service worker, o manifesto do PWA e os icones.

   O passo final confere que todo arquivo referenciado existe de verdade. Sem
   isso, um caminho digitado errado viraria 404 silencioso em producao.

   Rode:  npm run site     (o `npm run deploy` ja chama sozinho)
*/
import { cp, mkdir, rm, readFile, access } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destino = join(raiz, 'site');

/* Buscados pelo navegador sem aparecer como href/src no HTML: o manifesto cita
   os icones, e o service worker e registrado por JavaScript. */
const EXTRAS = ['index.html', 'sw.js', 'manifest.webmanifest', 'icone-180.png', 'icone-512.png'];

/* Casa `href="src/..."` e `src="..."` apenas para caminho local — o que comeca
   com `http`, `//` ou `data:` fica de fora, que e o caso das bibliotecas de CDN
   e das fontes do Google. */
const REFERENCIA = /(?:href|src)="(?!https?:|\/\/|data:|#)([^"]+)"/g;

function referenciasDoHtml(html) {
  const achadas = new Set();
  for (const [, caminho] of html.matchAll(REFERENCIA)) {
    /* O painel monta `<img src="${photo.data}">` em varios pontos, dentro de
       template literal no JavaScript. Isso nao e arquivo do projeto: e um
       object URL resolvido no navegador. Tentar copiar viraria erro de
       "arquivo nao existe" em toda build. */
    if (caminho.includes('${')) continue;
    /* `./algo` e `algo` sao o mesmo arquivo; normalizar evita copiar duas vezes
       e evita duas entradas para o mesmo destino. */
    const limpo = caminho.replace(/^\.\//, '').split(/[?#]/)[0];
    if (limpo) achadas.add(limpo);
  }
  return achadas;
}

/* Recusa caminho que escape da pasta do projeto.

   `../../.dev.vars` num href publicaria um segredo. O HTML e escrito por nos, e
   nao por terceiros, mas a checagem custa tres linhas e remove a classe inteira
   de erro — inclusive o acidente de um caminho relativo mal escrito. */
function dentroDoProjeto(relativo) {
  const absoluto = resolve(raiz, relativo);
  return absoluto === raiz || absoluto.startsWith(raiz + sep);
}

async function existe(caminho) {
  try {
    await access(caminho);
    return true;
  } catch {
    return false;
  }
}

async function montar() {
  const html = await readFile(join(raiz, 'index.html'), 'utf8');
  const arquivos = referenciasDoHtml(html);
  for (const extra of EXTRAS) arquivos.add(extra);

  const suspeitos = [...arquivos].filter((item) => !dentroDoProjeto(item));
  if (suspeitos.length) {
    throw new Error(`Caminho fora do projeto, recusado: ${suspeitos.join(', ')}`);
  }

  const faltando = [];
  for (const item of arquivos) {
    if (!(await existe(join(raiz, item)))) faltando.push(item);
  }
  if (faltando.length) {
    throw new Error(
      `O index.html aponta arquivo que nao existe: ${faltando.join(', ')}.\n`
      + 'Corrija o caminho antes de publicar — em producao isso vira 404.'
    );
  }

  /* Apaga antes de copiar. Sem isso, um arquivo renomeado deixaria a versao
     antiga para tras, e ela continuaria sendo publicada e servida. */
  await rm(destino, { recursive: true, force: true });
  await mkdir(destino, { recursive: true });

  const ordenados = [...arquivos].sort();
  for (const item of ordenados) {
    const alvo = join(destino, normalize(item));
    await mkdir(dirname(alvo), { recursive: true });
    await cp(join(raiz, item), alvo);
  }

  console.log(`site/ montado com ${ordenados.length} arquivos:`);
  for (const item of ordenados) console.log(`  ${item}`);
}

montar().catch((erro) => {
  console.error(`Falha ao montar o site: ${erro.message}`);
  process.exitCode = 1;
});

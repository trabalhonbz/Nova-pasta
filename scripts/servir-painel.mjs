/* Servidor estático para desenvolvimento do painel.

   Por que ele existe: abrir o index.html por `file://` faz o navegador enviar
   `Origin: null`, e o Worker recusa — liberar origem nula com token de sessão em
   jogo abriria a API para qualquer página local. Servindo por HTTP a origem
   passa a ser `http://localhost:8788`, que consta em ORIGENS no wrangler.toml.

   Rode com `npm run painel`, com o `npm run dev` ativo noutro terminal.

   Não é servidor de produção: sem compressão, sem cache, sem TLS. Para publicar,
   o destino é o Cloudflare Pages.
*/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const porta = Number(process.env.PORTA || 8788);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

/* Impede que `../` no caminho pedido saia da pasta do projeto e sirva arquivo
   de qualquer lugar do disco — inclusive o .dev.vars, que tem o segredo. */
function caminhoSeguro(pedido) {
  const limpo = normalize(decodeURIComponent(pedido.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const alvo = join(raiz, limpo === '/' || limpo === '\\' ? 'index.html' : limpo);
  return alvo.startsWith(raiz) ? alvo : null;
}

const BLOQUEADOS = ['.dev.vars', '.env', 'node_modules', '.git'];

const servidor = createServer(async (requisicao, resposta) => {
  const alvo = caminhoSeguro(requisicao.url || '/');
  if (!alvo || BLOQUEADOS.some((item) => alvo.includes(item))) {
    resposta.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    resposta.end('Acesso negado.');
    return;
  }

  try {
    const info = await stat(alvo);
    const arquivo = info.isDirectory() ? join(alvo, 'index.html') : alvo;
    const conteudo = await readFile(arquivo);
    resposta.writeHead(200, {
      'content-type': TIPOS[extname(arquivo).toLowerCase()] || 'application/octet-stream',
      /* Sem cache: no desenvolvimento, versão velha do index.html em cache custa
         mais tempo de diagnóstico do que a banda economizada. */
      'cache-control': 'no-store'
    });
    resposta.end(conteudo);
  } catch {
    resposta.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    resposta.end('Não encontrado.');
  }
});

servidor.listen(porta, () => {
  console.log(`Painel servido em http://localhost:${porta}`);
  console.log('Use esse endereço, não file:// — o Worker recusa origem nula.');
});

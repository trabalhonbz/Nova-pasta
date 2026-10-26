/* Testes da camada de mídia (src/db.js).

   Rode com `npm run test:midia`, ou junto com o resto por `npm test`.

   Dois substitutos são indispensáveis e explicam o preparo abaixo:

   - o jsdom não implementa IndexedDB (`window.indexedDB` é undefined), então a
     suíte injeta o `fake-indexeddb`, que é a mesma API rodando em memória;
   - o jsdom também não implementa `URL.createObjectURL`. O shim daqui devolve
     uma URL sintética e guarda o Blob, o que é suficiente para conferir cache e
     revogação — o que não se verifica fora do navegador é se a imagem aparece,
     e isso continua sendo conferência manual.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { teste, confirmar, igual, executar } from './harness.js';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const caminhoDb = path.join(testsDir, '..', 'src', 'db.js');
const fonteDb = fs.readFileSync(caminhoDb, 'utf8');

/* Sobe uma janela isolada com a camada carregada. `comIndexedDB: false` simula
   modo privado ou origem não segura, onde a camada deve degradar sem lançar. */
async function montar({ comIndexedDB = true } = {}) {
  /* `runScripts: 'outside-only'` dá à janela um `eval` próprio. Sem ele o
     `janela.eval` roda no contexto do Node, onde `window` não existe, e a
     camada se registraria no globalThis do processo em vez de na janela. */
  const dom = new JSDOM('<html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only'
  });
  const janela = dom.window;

  if (comIndexedDB) {
    /* Instância nova por teste: o fake-indexeddb compartilha estado por módulo,
       e bancos vazados entre casos mascarariam erro de limpeza. */
    const { IDBFactory } = await import('fake-indexeddb');
    janela.indexedDB = new IDBFactory();
  } else {
    janela.indexedDB = undefined;
  }

  const blobsPorUrl = new Map();
  let sequencia = 0;
  janela.URL.createObjectURL = (blob) => {
    sequencia += 1;
    const url = `blob:http://localhost/${sequencia}`;
    blobsPorUrl.set(url, blob);
    return url;
  };
  janela.URL.revokeObjectURL = (url) => { blobsPorUrl.delete(url); };

  janela.eval(fonteDb);
  return { janela, midia: janela.NBZMidia, urlsVivas: () => blobsPorUrl.size };
}

/* JPEG mínimo de 1x1 em base64 — binário de verdade, não texto disfarçado, para
   que a conversão base64 <-> Blob seja exercitada como no uso real. */
const JPEG_1X1 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofGh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAA'
  + 'AAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAA'
  + 'AAD/2gAMAwEAAhEDEQA/AJQA/9k=';

async function bytesDe(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

/* ------------------------------------------------------------------ casos */

teste('com IndexedDB disponível a camada se declara utilizável', async () => {
  const { midia } = await montar();
  igual(await midia.disponivel(), true, 'disponivel() deveria responder true');
});

teste('sem IndexedDB a camada degrada em vez de lançar', async () => {
  const { midia } = await montar({ comIndexedDB: false });
  igual(await midia.disponivel(), false, 'disponivel() deveria responder false');
  /* O painel chama estes métodos no fluxo normal; nenhum pode explodir só
     porque o navegador não tem IndexedDB. */
  igual(await midia.guardarFoto('f1', new Blob(['x'])), false, 'guardar deveria falhar silenciosamente');
  igual(await midia.lerFoto('f1'), null, 'ler deveria devolver null');
  igual(await midia.urlDaFoto('f1'), '', 'urlDaFoto deveria devolver string vazia');
});

teste('guardar e ler devolve exatamente o mesmo binário', async () => {
  const { midia, janela } = await montar();
  const original = midia.dataUriParaBlob(JPEG_1X1);
  confirmar(original instanceof janela.Blob, 'dataUriParaBlob deveria devolver Blob');
  igual(await midia.guardarFoto('foto-1', original), true, 'guardarFoto deveria confirmar a gravação');

  const lido = await midia.lerFoto('foto-1');
  confirmar(lido, 'lerFoto deveria encontrar a foto gravada');

  /* O tipo é conferido no registro, não em `blob.type`: preservar o tipo na
     clonagem é responsabilidade do IndexedDB e o fake-indexeddb não o faz. O
     que a camada garante é o `tipo` que ela mesma gravou, e é dele que o
     upload para o R2 vai tirar o Content-Type. */
  const registro = await midia.lerRegistro('foto-1');
  igual(registro.tipo, 'image/jpeg', 'o tipo deveria ter sido guardado no registro');
  igual(registro.bytes, original.size, 'o tamanho deveria ter sido guardado no registro');

  const antes = await bytesDe(original);
  const depois = await bytesDe(lido);
  igual(depois.length, antes.length, 'o tamanho em bytes deveria ser idêntico');
  igual(depois.every((byte, i) => byte === antes[i]), true, 'os bytes deveriam ser idênticos');
});

teste('base64 vira Blob sem inflar e volta igual', async () => {
  const { midia } = await montar();
  const blob = midia.dataUriParaBlob(JPEG_1X1);
  const tamanhoBase64 = JPEG_1X1.length;

  /* O ganho que justifica a migração: o binário é menor que o texto base64. */
  confirmar(blob.size < tamanhoBase64 * 0.8,
    `o Blob (${blob.size}B) deveria ser bem menor que o base64 (${tamanhoBase64}B)`);

  const devolta = await midia.blobParaDataUri(blob);
  igual(devolta, JPEG_1X1, 'o data-URI reconstruído deveria bater com o original');
});

teste('data-URI inválido devolve null em vez de quebrar o carregamento', async () => {
  const { midia } = await montar();
  igual(midia.dataUriParaBlob(''), null, 'string vazia');
  igual(midia.dataUriParaBlob('não é data uri'), null, 'texto comum');
  igual(midia.dataUriParaBlob('data:image/jpeg;base64'), null, 'sem a vírgula separadora');
  igual(midia.dataUriParaBlob(null), null, 'null');
});

teste('a URL da foto é criada uma vez e reaproveitada', async () => {
  const { midia, urlsVivas } = await montar();
  await midia.guardarFoto('foto-1', midia.dataUriParaBlob(JPEG_1X1));

  const primeira = await midia.urlDaFoto('foto-1');
  const segunda = await midia.urlDaFoto('foto-1');
  igual(segunda, primeira, 'a segunda chamada deveria reaproveitar a URL');
  igual(urlsVivas(), 1, 'deveria existir só uma object URL viva');
});

teste('excluir a foto também revoga a URL, sem deixar Blob na memória', async () => {
  const { midia, urlsVivas } = await montar();
  await midia.guardarFoto('foto-1', midia.dataUriParaBlob(JPEG_1X1));
  await midia.urlDaFoto('foto-1');
  igual(urlsVivas(), 1, 'a URL deveria existir antes da exclusão');

  igual(await midia.removerFoto('foto-1'), true, 'removerFoto deveria confirmar');
  igual(urlsVivas(), 0, 'a URL deveria ter sido revogada');
  igual(await midia.lerFoto('foto-1'), null, 'a foto não deveria mais ser encontrada');
});

teste('a limpeza apaga só as fotos que o estado não referencia mais', async () => {
  const { midia } = await montar();
  await midia.guardarFoto('em-uso', midia.dataUriParaBlob(JPEG_1X1));
  await midia.guardarFoto('orfa-1', midia.dataUriParaBlob(JPEG_1X1));
  await midia.guardarFoto('orfa-2', midia.dataUriParaBlob(JPEG_1X1));

  const apagadas = await midia.removerOrfas(['em-uso']);
  igual(apagadas, 2, 'deveria ter apagado as duas órfãs');
  confirmar(await midia.lerFoto('em-uso'), 'a foto em uso deveria continuar');
  igual(await midia.lerFoto('orfa-1'), null, 'a órfã deveria ter sido apagada');
});

teste('a ocupação relata quantas fotos e quantos bytes estão guardados', async () => {
  const { midia } = await montar();
  const blob = midia.dataUriParaBlob(JPEG_1X1);
  await midia.guardarFoto('foto-1', blob);
  await midia.guardarFoto('foto-2', blob);

  const uso = await midia.ocupacao();
  igual(uso.fotos, 2, 'deveria contar duas fotos');
  igual(uso.bytes, blob.size * 2, 'deveria somar os bytes das duas');
});

teste('várias fotos resolvem as URLs numa única passada', async () => {
  const { midia } = await montar();
  const blob = midia.dataUriParaBlob(JPEG_1X1);
  await midia.guardarFoto('a', blob);
  await midia.guardarFoto('b', blob);

  /* Ids repetidos e inexistentes entram de propósito: a galeria do painel monta
     a lista a partir do estado, que pode estar à frente do que foi gravado. */
  const urls = await midia.urlsDasFotos(['a', 'b', 'a', 'inexistente', null]);
  igual(urls.get('a').startsWith('blob:'), true, 'a foto "a" deveria ter URL');
  igual(urls.get('b').startsWith('blob:'), true, 'a foto "b" deveria ter URL');
  igual(urls.get('inexistente'), '', 'id sem Blob deveria resolver vazio');
});

teste('o volume que estourava o localStorage cabe no IndexedDB', async () => {
  const { midia } = await montar();
  const tetoLocalStorage = 5 * 1024 * 1024;
  /* 40 fotos de 250 KB somam ~9,8 MiB: quase o dobro do teto de ~5 MB do
     localStorage, que é o limite que fazia o saveState() falhar com "Sem
     espaço para salvar as fotos neste navegador". */
  const recheio = new Uint8Array(250 * 1024).fill(7);
  for (let i = 0; i < 40; i += 1) {
    const ok = await midia.guardarFoto(`foto-${i}`, new Blob([recheio], { type: 'image/jpeg' }));
    igual(ok, true, `a foto ${i} deveria ter sido gravada`);
  }
  const uso = await midia.ocupacao();
  igual(uso.fotos, 40, 'as 40 fotos deveriam estar guardadas');
  confirmar(uso.bytes > tetoLocalStorage * 1.8,
    `deveria ter passado bem do teto do localStorage (guardou ${uso.bytes}B, teto ${tetoLocalStorage}B)`);
});

await executar('Painel NBZ — camada de mídia');

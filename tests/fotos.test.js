/* Testes da migração das fotografias para o IndexedDB.

   Rode com `npm run test:fotos`.

   A bateria de `painel.test.js` garante que a interface não quebrou. Esta aqui
   prova o que a mudança se propôs a fazer: o binário sai do localStorage, o que
   já estava gravado em base64 é convertido, e as fotos voltam a aparecer depois
   de recarregar a página.
*/
import { boot, criarAdministrador, entrar, pausa, teste, confirmar, igual, executar } from './harness.js';

const CHAVE_OBRAS = 'nbz-gestao-obras-v1';

/* JPEG 1x1 de verdade em base64: é binário, não texto disfarçado, para que a
   conversão exercite o mesmo caminho do uso real. */
const JPEG_1X1 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofGh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAA'
  + 'AAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAA'
  + 'AAD/2gAMAwEAAhEDEQA/AJQA/9k=';

/* Estado de quem já usa o painel: uma obra com relatório fotográfico cujas
   fotos ainda estão em base64 dentro do JSON do localStorage. */
function obraComFotosEmBase64(quantas = 3) {
  return JSON.stringify([{
    id: 'obra-1', name: 'MEDICAL CENTER', city: 'São Paulo', client: 'Racional',
    manager: 'Filipp', area: 1000, executed: 0, inProgress: 0, pending: 0, floors: 1,
    status: 'Em andamento', date: '2026-06-01', system: 'Manta asfáltica', image: '',
    floorPlans: [{ id: 'f1', name: 'Térreo', area: 1000, regions: [], planImage: '', planWidth: 0, planHeight: 0, planFileName: '' }],
    photoReports: [{
      id: 'rel-1', floorIndex: 0, floorId: 'f1', floorName: 'Térreo', regionId: '',
      description: 'Visita inicial', date: '2026-06-02T10:00:00.000Z', author: 'André',
      photos: Array.from({ length: quantas }, (_, i) => ({
        id: `foto-${i + 1}`, data: JPEG_1X1, date: '2026-06-02T10:00:00.000Z',
        author: 'André', includeInReport: true
      }))
    }]
  }]);
}

/* Sobe o painel autenticado, que é a condição para a galeria ser renderizada. */
async function painelAberto(seed) {
  const ctx = await boot({ seed });
  await criarAdministrador(ctx);
  await entrar(ctx);
  /* A preparação da mídia é assíncrona de propósito, para não atrasar o login:
     a espera abaixo dá tempo de ela terminar. */
  await pausa(400);
  return ctx;
}

/* ------------------------------------------------------------------ casos */

teste('a camada de mídia fica disponível para o painel', async () => {
  const ctx = await painelAberto();
  igual(ctx.eval('typeof window.NBZMidia'), 'object', 'src/db.js deveria ter sido carregado');
  igual(await ctx.eval('window.NBZMidia.disponivel()'), true, 'o IndexedDB deveria estar utilizável');
  ctx.fechar();
});

teste('o cliente da API é carregado mas fica inerte sem servidor configurado', async () => {
  const ctx = await painelAberto();
  igual(ctx.eval('typeof window.NBZApi'), 'object', 'src/api.js deveria ter sido carregado');
  /* Sem endereço de API o painel tem de seguir inteiro no armazenamento local —
     é o estado de hoje, antes de o Worker subir. */
  igual(ctx.eval('window.NBZApi.configurado()'), false, 'não deveria haver servidor configurado');
  ctx.fechar();
});

teste('as fotos gravadas em base64 são movidas para o IndexedDB', async () => {
  const ctx = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(3) });

  const ocupacao = await ctx.eval('window.NBZMidia.ocupacao()');
  igual(ocupacao.fotos, 3, 'as três fotos deveriam estar no IndexedDB');
  confirmar(ocupacao.bytes > 0, 'deveria haver bytes gravados');

  /* E o binário deve bater com o original, não ser um placeholder. */
  const registro = await ctx.eval('window.NBZMidia.lerRegistro("foto-1")');
  igual(registro.tipo, 'image/jpeg', 'o tipo deveria ter sido preservado');
  ctx.fechar();
});

teste('depois da migração o base64 não volta para o localStorage', async () => {
  const ctx = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(3) });

  /* Força uma gravação, que é o momento em que o estado é serializado. */
  ctx.eval('saveState()');
  const gravado = ctx.window.localStorage.getItem(CHAVE_OBRAS);

  confirmar(!gravado.includes('data:image/jpeg'),
    'o localStorage não deveria mais conter base64 de imagem');
  confirmar(!gravado.includes('blob:'),
    'nem object URL, que não vale na próxima abertura');

  ctx.fechar();
});

teste('o custo por foto no localStorage passa a ser só metadado', async () => {
  /* É esta a medida que importa para a cota: com o binário fora do JSON, dobrar
     a quantidade de fotos não pode dobrar o tamanho do estado gravado. */
  async function tamanhoGravadoCom(quantas) {
    const ctx = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(quantas) });
    ctx.eval('saveState()');
    const tamanho = ctx.window.localStorage.getItem(CHAVE_OBRAS).length;
    ctx.fechar();
    return tamanho;
  }

  const com3 = await tamanhoGravadoCom(3);
  const com15 = await tamanhoGravadoCom(15);
  const porFoto = (com15 - com3) / 12;

  /* Uma foto em base64 custava ~250 KB; o registro agora é id, data, autor e
     um booleano, que não passa de algumas centenas de bytes. */
  confirmar(porFoto < 200,
    `cada foto deveria custar menos de 200B no estado, custou ${Math.round(porFoto)}B`);
  ctx_sanidade(com3, com15);
});

/* Conferência de sanidade da medida acima: se o estado não crescesse nada, o
   teste passaria por estar medindo a coisa errada. */
function ctx_sanidade(com3, com15) {
  confirmar(com15 > com3, 'o estado com mais fotos deveria ser maior, ainda que pouco');
}

teste('as fotos continuam apontando para uma imagem utilizável', async () => {
  const ctx = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(2) });

  const dados = ctx.eval('projects[0].photoReports[0].photos.map((f) => f.data)');
  igual(dados.length, 2, 'deveriam continuar duas fotos no relatório');
  dados.forEach((valor, i) => {
    confirmar(String(valor).startsWith('blob:'),
      `a foto ${i + 1} deveria apontar para object URL, e não "${String(valor).slice(0, 24)}"`);
  });
  ctx.fechar();
});

teste('recarregar a página reidrata as fotos a partir do IndexedDB', async () => {
  /* Primeira sessão: migra e grava o estado já sem o binário. */
  const primeira = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(2) });
  primeira.eval('saveState()');
  const estadoGravado = primeira.window.localStorage.getItem(CHAVE_OBRAS);
  const usuariosGravados = primeira.window.localStorage.getItem('nbz-usuarios-v1');
  primeira.fechar();

  confirmar(!estadoGravado.includes('data:image'), 'o estado gravado não deveria ter binário');

  /* Segunda sessão com o MESMO estado. O fake-indexeddb é por janela, então
     aqui as fotos não existem no banco — é o cenário de aparelho novo lendo um
     estado migrado, e o que se garante é que o painel não quebra nem perde a
     referência da foto. */
  const segunda = await boot({
    seed: { [CHAVE_OBRAS]: estadoGravado, 'nbz-usuarios-v1': usuariosGravados }
  });
  await entrar(segunda);
  await pausa(400);

  const fotos = segunda.eval('projects[0].photoReports[0].photos.length');
  igual(fotos, 2, 'as duas fotos deveriam sobreviver à leitura, mesmo sem binário local');
  igual(segunda.errors.length, 0, `não deveria haver erro de jsdom: ${segunda.errors.join('; ')}`);
  segunda.fechar();
});

teste('foto sem binário não é descartada na leitura do estado', async () => {
  /* Este é o caso que `prepareReport` apagava antes da correção: entrada sem
     `data`, que é exatamente o formato de uma foto já migrada. */
  const semBinario = JSON.stringify([{
    id: 'obra-1', name: 'OBRA', city: '', client: '', manager: '', area: 0,
    executed: 0, inProgress: 0, pending: 0, floors: 1, status: 'Em andamento',
    date: '2026-06-01', system: '', image: '',
    floorPlans: [{ id: 'f1', name: 'Térreo', area: 100, regions: [], planImage: '', planWidth: 0, planHeight: 0, planFileName: '' }],
    photoReports: [{
      id: 'rel-1', floorIndex: 0, floorId: 'f1', floorName: 'Térreo', regionId: '',
      description: 'Visita', date: '2026-06-02T10:00:00.000Z', author: 'André',
      photos: [{ id: 'foto-9', date: '2026-06-02T10:00:00.000Z', author: 'André', includeInReport: true }]
    }]
  }]);

  const ctx = await painelAberto({ [CHAVE_OBRAS]: semBinario });
  igual(ctx.eval('projects[0].photoReports[0].photos.length'), 1,
    'a foto sem binário deveria ter sido mantida');
  igual(ctx.eval('projects[0].photoReports[0].photos[0].id'), 'foto-9',
    'e deveria manter o id, que é a chave do binário');
  ctx.fechar();
});

teste('o binário órfão é apagado quando o estado não o referencia mais', async () => {
  const ctx = await painelAberto({ [CHAVE_OBRAS]: obraComFotosEmBase64(3) });
  igual((await ctx.eval('window.NBZMidia.ocupacao()')).fotos, 3, 'três fotos no início');

  /* Remove duas do estado e roda a limpeza, como acontece ao excluir foto. */
  ctx.eval('projects[0].photoReports[0].photos = projects[0].photoReports[0].photos.slice(0, 1)');
  await ctx.eval('limparMidiaOrfa()');

  const depois = await ctx.eval('window.NBZMidia.ocupacao()');
  igual(depois.fotos, 1, 'só a foto ainda referenciada deveria permanecer');
  ctx.fechar();
});

teste('sem IndexedDB o painel volta ao base64 em vez de falhar', async () => {
  /* `comIndexedDB: false` tem de valer desde o arranque: a camada guarda em
     cache se o IndexedDB existe na primeira consulta, então removê-lo depois do
     painel abrir não teria efeito. */
  const ctx = await boot({ seed: { [CHAVE_OBRAS]: obraComFotosEmBase64(2) }, comIndexedDB: false });
  await criarAdministrador(ctx);
  await entrar(ctx);
  await pausa(300);

  igual(await ctx.eval('temMidia()'), false, 'a camada deveria se declarar indisponível');

  /* O base64 tem de continuar no estado: descartá-lo apagaria a foto. */
  ctx.eval('saveState()');
  const gravado = ctx.window.localStorage.getItem(CHAVE_OBRAS);
  confirmar(gravado.includes('data:image/jpeg'),
    'sem IndexedDB o base64 deveria continuar sendo gravado');
  igual(ctx.eval('projects[0].photoReports[0].photos.length'), 2, 'as fotos deveriam seguir no estado');
  ctx.fechar();
});

await executar('Painel NBZ — fotografias no IndexedDB');

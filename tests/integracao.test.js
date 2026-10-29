/* Testes de integração: painel + Worker + D1, ponta a ponta sem rede.

   Rode com `npm run test:integracao`.

   O caminho exercitado é o real: formulário do index.html -> src/api.js ->
   roteador do Worker -> D1. O D1 é SQLite em memória pelo `node:sqlite`, que é
   o mesmo motor do Cloudflare; o `fetch` do jsdom chama a função do Worker
   direto, sem socket no meio.

   O que estes testes NÃO cobrem, e só o deploy confirma:
   - o limite de 10 ms de CPU do plano gratuito do Workers;
   - o R2 de verdade (aqui ele é um objeto em memória);
   - latência, DNS e o comportamento do navegador com a rede caindo.
*/
import { readFileSync } from 'node:fs';
import { adaptarD1, bancoNovo } from './d1-memoria.mjs';
import { boot, pausa, teste, confirmar, igual, executar } from './harness.js';
import worker from '../src/worker/index.js';
/* Chamado direto nos testes de permissão: o painel nunca oferece o botão ao
   cargo sem autorização, então só a chamada crua exercita a guarda do servidor
   — que é justamente onde a regra tinha divergido. */
import * as fotos from '../src/worker/fotos.js';
import * as sync from '../src/worker/sync.js';

/* `src/sincronizar.js` é um IIFE que se pendura no global do navegador. Avaliá-lo
   aqui dá acesso à tradução e à fusão como funções puras, sem subir um painel em
   jsdom só para exercitar lógica que não toca em DOM nenhum. */
new Function(readFileSync(new URL('../src/sincronizar.js', import.meta.url), 'utf8'))();
const NBZSync = globalThis.NBZSync;


const ENDERECO = 'https://api-de-teste.workers.dev';

/* ----------------------------------------------------------- adaptadores */

/* R2 em memória com a parte da interface que src/worker/fotos.js usa. */
function r2EmMemoria() {
  const objetos = new Map();
  return {
    async put(chave, dados, opcoes = {}) {
      objetos.set(chave, { dados, meta: (opcoes.httpMetadata || {}) });
      return { key: chave };
    },
    async get(chave) {
      const item = objetos.get(chave);
      if (!item) return null;
      return {
        body: item.dados,
        httpEtag: `"${chave}"`,
        writeHttpMetadata: (cabecalhos) => {
          if (item.meta.contentType) cabecalhos.set('content-type', item.meta.contentType);
        }
      };
    },
    async delete(chave) { objetos.delete(chave); },
    _tamanho: () => objetos.size
  };
}

/* Sobe um servidor e devolve o que o harness precisa para ligar o painel nele.
   `db` fica exposto para os testes conferirem o que foi gravado. */
function servidorDeTeste() {
  const db = bancoNovo();
  const env = {
    DB: adaptarD1(db),
    FOTOS: r2EmMemoria(),
    PEPPER: 'pepper-de-teste-nao-usar-em-producao',
    /* O painel roda em http://localhost no jsdom; a origem tem de constar para
       o CORS não recusar. */
    ORIGENS: 'http://localhost'
  };
  const contexto = { waitUntil: (promessa) => promessa };
  return {
    db,
    env,
    api: {
      endereco: ENDERECO,
      atender: (pedido) => worker.fetch(pedido, env, contexto)
    }
  };
}

/* O painel usa a tela de login/cadastro de verdade; estas funções apenas
   preenchem os campos e disparam o submit, como um usuário faria. */
async function preencherCadastroInicial(ctx, { nome, usuario, senha }) {
  ctx.doc.querySelector('#setupName').value = nome;
  ctx.doc.querySelector('#setupUser').value = usuario;
  ctx.doc.querySelector('#setupPassword').value = senha;
  ctx.doc.querySelector('#setupPasswordConfirm').value = senha;
  ctx.submit('#authSetupForm');
  await pausa(900);
}

async function preencherLogin(ctx, { usuario, senha }) {
  ctx.doc.querySelector('#loginUser').value = usuario;
  ctx.doc.querySelector('#loginPassword').value = senha;
  ctx.submit('#authLoginForm');
  await pausa(900);
}

function painelAberto(ctx) {
  return ctx.doc.querySelector('#appShell').hidden === false;
}

/* ------------------------------------------------------------------ casos */

teste('com servidor configurado o painel se declara em modo remoto', async () => {
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(500);

  igual(ctx.eval('window.NBZApi.configurado()'), true, 'a API deveria estar configurada');
  igual(ctx.eval('comServidor'), true, 'o painel deveria estar em modo remoto');
  ctx.fechar();
});

teste('servidor vazio leva o painel à tela de cadastro do administrador', async () => {
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);

  igual(ctx.doc.querySelector('#authSetupForm').hidden, false, 'o cadastro inicial deveria aparecer');
  igual(ctx.doc.querySelector('#authLoginForm').hidden, true, 'o login deveria estar oculto');
  ctx.fechar();
});

teste('o administrador é criado no servidor e a sessão abre', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);

  await preencherCadastroInicial(ctx, { nome: 'André Mendonça', usuario: 'andre', senha: 'senhaforte1' });

  confirmar(painelAberto(ctx), 'o painel deveria ter aberto depois do cadastro');
  igual(ctx.eval('currentUser.role'), 'administrador', 'o cargo deveria vir do servidor');
  igual(ctx.eval('currentUser.remoto'), true, 'o usuário deveria estar marcado como remoto');

  /* E o registro tem de estar no D1, não só na tela. */
  const linha = db.prepare('select usuario, nome, nivel_acesso from usuarios').get();
  igual(linha.usuario, 'andre', 'o usuário deveria ter sido gravado no D1');
  igual(linha.nivel_acesso, 'administrador', 'com cargo de administrador');
  ctx.fechar();
});

teste('a senha não trafega: o servidor recebe o hash', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });

  const linha = db.prepare('select senha_hash, senha_salt from usuarios where usuario = ?').get('andre');
  confirmar(!linha.senha_hash.includes('senhaforte1'), 'a senha não deveria aparecer no hash gravado');
  confirmar(/^[0-9a-f]{64}$/.test(linha.senha_hash), 'o hash deveria ser HMAC-SHA256 em hex');
  confirmar(/^[0-9a-f]{32}$/.test(linha.senha_salt), 'o salt deveria ter 16 bytes em hex');
  ctx.fechar();
});

teste('depois de cadastrada, a pessoa entra sozinha com usuário e senha', async () => {
  /* É o fluxo que o sistema precisa atender: o administrador cadastra, a pessoa
     entra por conta própria em outro aparelho. */
  const { api, env } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  confirmar(painelAberto(primeira), 'o administrador deveria estar dentro');

  /* O administrador cadastra o Richard, com a senha valendo definitivamente. */
  const criado = await primeira.eval(`window.NBZApi.cadastrarUsuario({
    nome: 'Richard Henrique', usuario: 'richard', nivelAcesso: 'encarregado',
    senha: 'senhadorichard1', exigirTrocaDeSenha: false
  })`);
  igual(criado.nivelAcesso, 'encarregado', 'o cargo deveria ter sido aceito');
  primeira.fechar();

  /* Outro aparelho: localStorage vazio, mesmo servidor. */
  const segunda = await boot({ api });
  await pausa(600);
  igual(segunda.doc.querySelector('#authLoginForm').hidden, false,
    'o segundo aparelho deveria mostrar login, não cadastro inicial');

  await preencherLogin(segunda, { usuario: 'richard', senha: 'senhadorichard1' });
  confirmar(painelAberto(segunda), 'o Richard deveria ter entrado sozinho');
  igual(segunda.eval('currentUser.name'), 'Richard Henrique', 'o nome deveria vir do servidor');
  igual(segunda.eval('currentUser.role'), 'encarregado', 'e o cargo também');
  segunda.fechar();
});

teste('senha errada mostra mensagem e não abre o painel', async () => {
  const { api } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  primeira.fechar();

  const segunda = await boot({ api });
  await pausa(600);
  await preencherLogin(segunda, { usuario: 'andre', senha: 'senhaerrada9' });

  confirmar(!painelAberto(segunda), 'o painel não deveria abrir');
  const aviso = segunda.doc.querySelector('#loginFeedback').textContent;
  confirmar(/inválidos/i.test(aviso), `a mensagem deveria indicar credenciais inválidas: "${aviso}"`);
  igual(segunda.doc.querySelector('#loginPassword').value, '', 'o campo de senha deveria ser limpo');
  segunda.fechar();
});

teste('a trava de tentativas vem do servidor, não do navegador', async () => {
  const { api } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  primeira.fechar();

  /* Cinco erros num aparelho... */
  const errando = await boot({ api });
  await pausa(600);
  for (let i = 0; i < 5; i += 1) {
    await preencherLogin(errando, { usuario: 'andre', senha: `errada${i}xx` });
  }
  errando.fechar();

  /* ...e a trava vale num aparelho LIMPO, com a senha CERTA. É isso que a trava
     antiga, contada no localStorage, não conseguia fazer: bastava limpar os
     dados do site para zerar o contador. */
  const limpo = await boot({ api });
  await pausa(600);
  await preencherLogin(limpo, { usuario: 'andre', senha: 'senhaforte1' });

  confirmar(!painelAberto(limpo), 'o painel não deveria abrir durante a trava');
  const aviso = limpo.doc.querySelector('#loginFeedback').textContent;
  confirmar(/tentativas/i.test(aviso), `deveria avisar da trava: "${aviso}"`);
  limpo.fechar();
});

teste('a sessão é retomada pelo token, sem pedir senha de novo', async () => {
  const { api } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  const token = primeira.window.localStorage.getItem('nbz-token-v1');
  const usuario = primeira.window.localStorage.getItem('nbz-usuario-v1');
  confirmar(token, 'o token deveria ter sido guardado');
  primeira.fechar();

  /* Mesma pessoa reabrindo o aplicativo: o token basta. */
  const reaberto = await boot({
    api, seed: { 'nbz-token-v1': token, 'nbz-usuario-v1': usuario }
  });
  await pausa(800);

  confirmar(painelAberto(reaberto), 'o painel deveria abrir direto, sem login');
  igual(reaberto.doc.querySelector('#authOverlay').hidden, true, 'a tela de login deveria ficar oculta');
  igual(reaberto.eval('currentUser.username'), 'andre', 'o usuário deveria ter sido retomado');
  reaberto.fechar();
});

teste('token inválido não abre o painel e volta para o login', async () => {
  const { api } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  primeira.fechar();

  const forjado = await boot({ api, seed: { 'nbz-token-v1': JSON.stringify('0'.repeat(64)) } });
  await pausa(800);

  confirmar(!painelAberto(forjado), 'token forjado não deveria abrir o painel');
  igual(forjado.doc.querySelector('#authOverlay').hidden, false, 'deveria voltar para a tela de entrada');
  ctx_semToken(forjado);
  forjado.fechar();
});

function ctx_semToken(ctx) {
  igual(ctx.window.localStorage.getItem('nbz-token-v1'), null,
    'o token recusado deveria ter sido descartado');
}

teste('sair encerra a sessão no servidor', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  igual(db.prepare('select count(*) as t from sessoes').get().t, 1, 'deveria haver uma sessão');

  ctx.doc.querySelector('#logoutButton').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await pausa(600);

  igual(db.prepare('select count(*) as t from sessoes').get().t, 0,
    'a sessão deveria ter saído do D1, não apenas do aparelho');
  igual(ctx.window.localStorage.getItem('nbz-token-v1'), null, 'o token local deveria ter sido limpo');
  ctx.fechar();
});

teste('o segundo administrador só existe se o primeiro o cadastrar', async () => {
  const { api } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  primeira.fechar();

  /* Aparelho novo: a tela tem de ser de login, nunca de cadastro inicial —
     senão qualquer um abriria um sistema paralelo com acesso total. */
  const invasor = await boot({ api });
  await pausa(700);
  igual(invasor.doc.querySelector('#authSetupForm').hidden, true,
    'o cadastro inicial não deveria estar disponível');
  igual(invasor.doc.querySelector('#authLoginForm').hidden, false, 'deveria mostrar o login');
  invasor.fechar();
});

/* ----------------------------------------- fotos entre dois aparelhos */

/* JPEG 1x1 real, para o Worker aceitar: ele confere a assinatura do arquivo,
   não o Content-Type. */
const JPEG_1X1 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofGh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAA'
  + 'AAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAA'
  + 'AAD/2gAMAwEAAhEDEQA/AJQA/9k=';

/* Monta no painel uma obra com pavimento, setor, relatório e uma fotografia
   com binário de verdade no IndexedDB.

   A foto é inserida pelo estado, e não pela interface, porque `compressPhoto`
   depende de `canvas.toDataURL`, que o jsdom não implementa. O que importa aqui
   é o caminho a partir do estado — que é onde a sincronização atua. */
async function criarObraComFoto(ctx) {
  return ctx.eval(`(async () => {
    const blob = window.NBZMidia.dataUriParaBlob(${JSON.stringify(JPEG_1X1)});
    await window.NBZMidia.guardarFoto('foto-1', blob);
    const url = await window.NBZMidia.urlDaFoto('foto-1');
    projects = [{
      id: 'obra-1', name: 'MEDICAL CENTER', city: 'São Paulo', client: 'Racional',
      manager: 'Filipp', system: 'Manta asfáltica', status: 'Em andamento',
      date: '2026-06-01', image: '', area: 1000,
      executed: 0, inProgress: 0, pending: 0, blocked: 0, unclassified: 0, floors: 1,
      floorPlans: [{
        id: 'pav-1', name: 'Térreo', area: 1000, planImage: '', planWidth: 0,
        planHeight: 0, planFileName: '',
        regions: [{ id: 'set-1', name: 'Setor A', status: 'executed', points: [{x:10,y:20}], area: 120 }]
      }],
      photoReports: [{
        id: 'rel-1', floorIndex: 0, floorId: 'pav-1', floorName: 'Térreo',
        regionId: 'set-1', description: 'Manta aplicada no Setor A',
        date: '2026-06-02T10:00:00.000Z', author: 'André',
        photos: [{ id: 'foto-1', data: url, date: '2026-06-02T10:00:00.000Z', author: 'André', includeInReport: true }]
      }]
    }];
    saveState();
    return url;
  })()`);
}

teste('a fotografia tirada num aparelho chega ao servidor', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  confirmar(painelAberto(ctx), 'o painel deveria ter aberto');

  const url = await criarObraComFoto(ctx);
  confirmar(String(url).startsWith('blob:'), 'a foto deveria ter object URL local');

  const resultado = await ctx.eval('sincronizarComServidor()');
  confirmar(resultado, 'a sincronização deveria ter rodado');

  /* O estado tem de estar no D1 — é o que dá à foto onde se pendurar. */
  igual(db.prepare('select count(*) as t from obras').get().t, 1, 'a obra deveria estar no D1');
  igual(db.prepare('select count(*) as t from pavimentos').get().t, 1, 'o pavimento também');
  igual(db.prepare('select count(*) as t from setores').get().t, 1, 'o setor também');
  igual(db.prepare('select count(*) as t from relatorios_foto').get().t, 1, 'o relatório também');

  /* E a foto, com o binário no R2. */
  const foto = db.prepare('select id, relatorio_id, r2_key, bytes from fotos').get();
  confirmar(foto, 'a fotografia deveria ter sido registrada');
  igual(foto.id, 'foto-1', 'com o mesmo id do painel');
  igual(foto.relatorio_id, 'rel-1', 'ligada ao relatório certo');
  confirmar(foto.bytes > 0, `o binário deveria ter tamanho (${foto.bytes}B)`);
  confirmar(/^obras\/obra-1\/rel-1\//.test(foto.r2_key),
    `a chave no bucket deveria ser por obra e relatório, e é "${foto.r2_key}"`);
  ctx.fechar();
});

teste('a situação do setor chega com o vocabulário do painel', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');

  /* 'executed' e não 'finalizada': traduzir criaria dois vocabulários, e o
     CHECK do schema recusaria em silêncio o que divergisse. */
  const setor = db.prepare('select situacao, area from setores where id = ?').get('set-1');
  igual(setor.situacao, 'executed', 'a situação deveria ser a do painel');
  igual(setor.area, 120, 'a área deveria ter sido gravada');

  /* E a mudança de situação vira linha de histórico, não sobrescrita. */
  const log = db.prepare('select situacao from setor_situacao_log where setor_id = ?').all('set-1');
  igual(log.length, 1, 'deveria haver uma linha no histórico de situação');
  ctx.fechar();
});

teste('outro aparelho recebe a obra e a fotografia', async () => {
  /* O teste que responde à pergunta toda: a foto registrada num aparelho
     aparece em outro, sem nada em comum além do servidor. */
  const { api } = servidorDeTeste();

  const primeiro = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeiro, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(primeiro);
  await primeiro.eval('sincronizarComServidor()');
  primeiro.fechar();

  /* Aparelho limpo: localStorage vazio, IndexedDB vazio, mesmo servidor. */
  const segundo = await boot({ api });
  await pausa(600);
  /* O painel nasce com duas obras de demonstração; o que importa é que a obra
     do primeiro aparelho ainda não está aqui. */
  igual(segundo.eval('projects.some((p) => p.id === "obra-1")'), false,
    'a obra do outro aparelho não deveria existir antes de sincronizar');

  await preencherLogin(segundo, { usuario: 'andre', senha: 'senhaforte1' });
  confirmar(painelAberto(segundo), 'deveria ter entrado');
  /* O login dispara `sincronizarComServidor({completo: true})`; a espera dá
     tempo de a descida e o download do binário terminarem. */
  await pausa(1500);

  igual(segundo.eval('projects.some((p) => p.id === "obra-1")'), true, 'a obra deveria ter chegado');
  igual(segundo.eval('projects.find((p) => p.id === "obra-1").name'), 'MEDICAL CENTER', 'com o nome certo');
  igual(segundo.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].regions[0].status'), 'executed',
    'e a situação do setor preservada');

  const fotos = segundo.eval('projects.find((p) => p.id === "obra-1").photoReports[0].photos');
  igual(fotos.length, 1, 'a fotografia deveria ter chegado');
  igual(fotos[0].id, 'foto-1', 'com o mesmo id');
  confirmar(String(fotos[0].data).startsWith('blob:'),
    `o binário deveria ter sido baixado e virado object URL, e é "${String(fotos[0].data).slice(0, 30)}"`);

  /* E o binário tem de estar guardado no aparelho, para abrir offline depois. */
  const guardado = await segundo.eval('window.NBZMidia.lerRegistro("foto-1")');
  confirmar(guardado && guardado.bytes > 0, 'o binário deveria ter ficado no IndexedDB local');
  igual(guardado.tipo, 'image/jpeg', 'com o tipo correto');
  segundo.fechar();
});

teste('a mesma fotografia não é enviada duas vezes', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  await ctx.eval('sincronizarComServidor()');
  const depoisDaPrimeira = db.prepare('select count(*) as t from fotos').get().t;

  /* Sincronizar de novo não pode reenviar: sem a lista de enviadas, cada
     sincronização recolocaria todas as fotos na fila. */
  await ctx.eval('sincronizarComServidor()');
  await ctx.eval('sincronizarComServidor()');

  igual(db.prepare('select count(*) as t from fotos').get().t, depoisDaPrimeira,
    'a contagem de fotos não deveria crescer');
  igual(ctx.eval('window.NBZApi.pendentes()'), 0, 'a fila deveria estar vazia');
  ctx.fechar();
});

/* ------------------------------------- sem R2: as fotos esperam, não somem */

/* Servidor sem o binding do R2, como fica enquanto o armazenamento não é
   ativado na conta. Tudo o mais precisa continuar funcionando. */
function servidorSemR2() {
  const { db, env, api } = servidorDeTeste();
  delete env.FOTOS;
  return { db, env, api };
}

teste('sem R2 o resto do sistema funciona normalmente', async () => {
  const { api, db } = servidorSemR2();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  confirmar(painelAberto(ctx), 'o login deveria funcionar sem o R2');

  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');

  /* Obra, pavimento, setor e relatório não dependem do bucket. */
  igual(db.prepare('select count(*) as t from obras').get().t, 1, 'a obra deveria ter subido');
  igual(db.prepare('select count(*) as t from setores').get().t, 1, 'o setor também');
  igual(db.prepare('select count(*) as t from relatorios_foto').get().t, 1, 'o relatório também');
  ctx.fechar();
});

teste('sem R2 a fotografia fica na fila em vez de ser descartada', async () => {
  const { api } = servidorSemR2();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');

  /* O 503 é erro de servidor, não do envio: repetir resolve quando o bucket
     existir. Fosse tratado como 4xx, a foto sairia da fila e nunca subiria. */
  igual(ctx.eval('window.NBZApi.pendentes()'), 1, 'a foto deveria continuar na fila');
  igual(ctx.eval('window.NBZApi.fotosEnviadas().size'), 0, 'e não deveria constar como enviada');

  /* E o binário segue no aparelho — a galeria continua abrindo. */
  const guardado = await ctx.eval('window.NBZMidia.lerRegistro("foto-1")');
  confirmar(guardado && guardado.bytes > 0, 'o binário deveria estar guardado no aparelho');
  ctx.fechar();
});

teste('quando o R2 aparece, a fila acumulada sobe sozinha', async () => {
  /* O cenário real: hoje sem cartão, semana que vem com o bucket ativo. O que
     foi registrado no meio-tempo não pode ter se perdido. */
  const { env, api, db } = servidorSemR2();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');
  igual(ctx.eval('window.NBZApi.pendentes()'), 1, 'a foto está esperando');
  igual(db.prepare('select count(*) as t from fotos').get().t, 0, 'e ainda não subiu');

  /* O bucket é ativado. Nada muda no painel nem no aparelho. */
  env.FOTOS = r2EmMemoria();

  await ctx.eval('sincronizarComServidor()');

  igual(ctx.eval('window.NBZApi.pendentes()'), 0, 'a fila deveria ter escoado');
  const foto = db.prepare('select id, bytes from fotos').get();
  confirmar(foto, 'a fotografia deveria ter subido');
  igual(foto.id, 'foto-1', 'com o mesmo id de quando foi tirada');
  confirmar(foto.bytes > 0, 'e com o binário íntegro');
  ctx.fechar();
});

/* ------------------------------- ciclo completo do pavimento (ADM) */

/* Cadastra uma pessoa e já troca a senha provisória, para ela poder sincronizar.

   Sem a troca o servidor recusa TODAS as rotas com 428 — regra que existe para
   o administrador deixar de conhecer a senha de quem usa o sistema. Num teste
   que precisa de dois usuários de verdade sincronizando, essa é a única forma
   de chegar lá. */
async function criarColegaComSenhaPropria(admin, { nome, usuario, provisoria, definitiva, cargo = 'engenheiro' }) {
  await cadastrarPeloPainel(admin, { nome, usuario, senha: provisoria, cargo });

  const dele = await boot({ api: admin.__api });
  await pausa(600);
  await preencherLogin(dele, { usuario, senha: provisoria });
  await pausa(900);
  await dele.eval(`(async () => {
    await window.NBZApi.trocarSenha(${JSON.stringify(provisoria)}, ${JSON.stringify(definitiva)});
  })()`);
  await pausa(600);
  dele.fechar();

  /* A troca derruba as sessões, inclusive a dele: entra de novo com a nova. */
  const reaberto = await boot({ api: admin.__api });
  await pausa(600);
  await preencherLogin(reaberto, { usuario, senha: definitiva });
  await pausa(1500);
  return reaberto;
}

teste('ADM cria pavimento, todos veem; ADM exclui, some para todos', async () => {
  /* O teste que o usuário pediu, de ponta a ponta e com dois usuários distintos
     — não dois aparelhos do mesmo login. É o requisito inteiro num caso só:
     criar aparece para todos, excluir some para todos. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  admin.__api = api;
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });

  const colega = await criarColegaComSenhaPropria(admin, {
    nome: 'Nicolas', usuario: 'nicolas', provisoria: 'provisoria123', definitiva: 'senhadele456'
  });

  /* ---- 1. o ADM cria o pavimento ---- */
  await admin.eval(`(() => {
    projects = [{
      id: 'obra-1', name: 'MEDICAL CENTER', city: 'São Paulo', client: 'Racional',
      manager: 'Filipp', system: 'Manta asfáltica', status: 'Em andamento',
      date: '2026-06-01', image: '', area: 1000,
      executed: 0, inProgress: 0, pending: 0, blocked: 0, unclassified: 0, floors: 1,
      floorPlans: [{ id: 'pav-novo', name: 'Térreo', area: 77, planImage: '', planWidth: 0, planHeight: 0, planFileName: '', regions: [] }],
      photoReports: []
    }];
    saveState();
  })()`);
  await admin.eval('sincronizarComServidor()');
  await pausa(600);

  igual(
    db.prepare("select nome from pavimentos where id = 'pav-novo' and excluido_em is null").get().nome,
    'Térreo', 'o pavimento tem de estar no servidor'
  );

  /* ---- 2. o colega vê ---- */
  await colega.eval('sincronizarComServidor({ apenasBaixar: true })');
  await pausa(800);
  igual(
    await colega.eval('(projects.find((p) => p.id === "obra-1") || {floorPlans:[]}).floorPlans.map((f) => f.id)'),
    ['pav-novo'], 'o colega, que é outro usuário, tem de ver o pavimento criado'
  );

  /* ---- 3. o ADM exclui ---- */
  admin.window.confirm = () => true;
  await admin.eval('deleteProjectFloor("obra-1", 0)');
  await admin.eval('sincronizarComServidor()');
  await pausa(800);

  igual(
    db.prepare("select count(*) as t from pavimentos where id = 'pav-novo' and excluido_em is null").get().t, 0,
    'a exclusão tem de estar registrada no banco central'
  );
  igual(
    await admin.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 0,
    'e sumiu no aparelho de quem excluiu'
  );

  /* ---- 4. some para o colega, sem ele fazer nada ---- */
  await colega.eval('sincronizarComServidor({ apenasBaixar: true })');
  await pausa(800);
  igual(
    await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 0,
    'e tem de sumir para o outro usuário também'
  );

  /* ---- 5. não volta nem depois de sincronizar de novo ---- */
  await colega.eval('sincronizarComServidor({ completo: true })');
  await pausa(800);
  igual(
    await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 0,
    'e não pode ressurgir numa descida completa'
  );

  admin.fechar();
  colega.fechar();
});

/* Importa pelo MANIPULADOR REAL do painel, trocando só o rasterizador.

   O auxiliar `importarPlanta` grava direto no armazenamento e enfileira na mão —
   útil, mas pula `importFloorPlan`, que é o que roda de verdade quando alguém
   escolhe o arquivo. Se o defeito estiver ali (não gravar, não enfileirar, não
   marcar origem, usar o id errado), nenhum teste pegaria.

   Trocar o rasterizador é inevitável: ele depende de canvas, e o jsdom não tem.
   Tudo DEPOIS dele — que é onde mora a lógica — passa a ser exercitado. */
async function importarPelaTela(ctx, { largura = 1200, altura = 800, arquivo = 'planta.jpg' } = {}) {
  await ctx.eval(`(() => {
    window.__rasterizadorOriginal = rasterizePlanFile;
    rasterizePlanFile = async () => ({
      data: ${JSON.stringify(JPEG_1X1)}, width: ${largura}, height: ${altura}
    });
  })()`);
  ctx.window.confirm = () => true;
  await ctx.eval(`importFloorPlan({ name: ${JSON.stringify(arquivo)}, size: 1024, type: 'image/jpeg' })`);
  await pausa(500);
}

teste('importar pela tela grava, enfileira e marca origem', async () => {
  /* Percorre `importFloorPlan` de verdade e confere as três coisas que ele tem
     de deixar prontas: o desenho na tela, o binário no armazenamento sob o id do
     pavimento, e a planta na fila com marca de origem — sem a marca, a varredura
     não a envia e ela nunca chega ao servidor. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');

  await importarPelaTela(ctx);

  const estado = await ctx.eval(`(async () => {
    const pav = projects[0].floorPlans[0];
    return {
      desenho: pav.planImage,
      largura: pav.planWidth,
      arquivo: pav.planFileName,
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
      naFila: window.NBZApi.plantaPendente(pav.id),
      origem: window.NBZApi.plantasProprias().has(pav.id),
      erroNaTela: document.querySelector('#sketchError').textContent
    };
  })()`);

  confirmar(String(estado.desenho).startsWith('blob:'),
    `o desenho deveria aparecer, e veio "${estado.desenho}" (erro na tela: "${estado.erroNaTela}")`);
  confirmar(estado.binario, 'o binário deveria estar gravado sob o id do pavimento');
  confirmar(estado.naFila, 'a planta deveria estar na fila de envio');
  confirmar(estado.origem, 'e marcada como importada NESTE aparelho');
  igual(estado.largura, 1200, 'com as medidas do rasterizador');
  igual(estado.arquivo, 'planta.jpg', 'e o nome do arquivo');

  /* E sobe. */
  await ctx.eval('sincronizarComServidor()');
  await pausa(800);
  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'e o binário tem de chegar ao servidor'
  );
  ctx.fechar();
});

/* Obra sem nenhum pavimento: o pavimento vem do diálogo, que é o que se testa. */
async function criarObraVazia(ctx) {
  return ctx.eval(`(() => {
    projects = [{
      id: 'obra-1', name: 'MEDICAL CENTER', city: 'São Paulo', client: 'Racional',
      manager: 'Filipp', system: 'Manta asfáltica', status: 'Em andamento',
      date: '2026-06-01', image: '', area: 0,
      executed: 0, inProgress: 0, pending: 0, blocked: 0, unclassified: 0, floors: 0,
      floorPlans: [], photoReports: []
    }];
    saveState();
  })()`);
}

/* Cadastra o pavimento pelo DIÁLOGO "Adicionar pavimento", com planta.

   É por aqui que a planta entra na prática: a pessoa cria o pavimento e já
   escolhe o arquivo no mesmo formulário. O manipulador é outro, diferente do
   `importFloorPlan` do croqui — e era o único dos dois que não gravava no
   IndexedDB, não enfileirava e não marcava origem. Nenhum teste passava por
   ele, e por isso a suíte inteira ficava verde com o defeito em produção.

   Como em `importarPelaTela`, só o rasterizador é trocado: ele depende de
   canvas, que o jsdom não tem. Tudo depois dele é exercitado de verdade. */
async function cadastrarPavimentoComPlanta(ctx, {
  projeto = 'obra-1', nome = 'Térreo', area = '77',
  arquivo = 'N644-23-LOIM-0001-03S-HO-R00.pdf', largura = 1800, altura = 1272
} = {}) {
  await ctx.eval(`(() => {
    rasterizePlanFile = async () => ({
      data: ${JSON.stringify(JPEG_1X1)}, width: ${largura}, height: ${altura}
    });
    floorProjectId = ${JSON.stringify(projeto)};
    document.querySelector('#floorName').value = ${JSON.stringify(nome)};
    document.querySelector('#newFloorArea').value = ${JSON.stringify(area)};
    Object.defineProperty(document.querySelector('#addFloorPlanFile'), 'files', {
      configurable: true,
      value: [{ name: ${JSON.stringify(arquivo)}, size: 2048, type: 'application/pdf' }]
    });
  })()`);
  ctx.submit('#addFloorForm');
  await pausa(700);
}

teste('planta cadastrada junto com o pavimento grava, enfileira e marca origem', async () => {
  /* O RELATO, ao pé da letra: "depois que coloca a foto AQUI, quando eu vou
     fazer qualquer coisa na planta ela cai." O "aqui" é este diálogo.

     O que ele fazia: punha o data-URI em `planImage` e parava. Sem binário no
     IndexedDB, sem fila, sem marca de origem. A planta nunca subia — e na
     sincronização seguinte a fusão lia planta local + servidor sem planta +
     nenhuma marca, que é a assinatura exata de "o administrador apagou", e
     zerava o desenho.

     As três garantias conferidas aqui são as mesmas que `importFloorPlan` já
     dava. O defeito era a diferença entre os dois caminhos, não a regra. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(ctx);

  await cadastrarPavimentoComPlanta(ctx);

  const estado = await ctx.eval(`(async () => {
    const pav = projects[0].floorPlans[0];
    if (!pav) return { semPavimento: true, erroNaTela: document.querySelector('#addFloorError').textContent };
    return {
      id: pav.id,
      desenho: pav.planImage || '',
      largura: pav.planWidth,
      arquivo: pav.planFileName,
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
      naFila: window.NBZApi.plantaPendente(pav.id),
      origem: window.NBZApi.plantasProprias().has(pav.id),
      erroNaTela: document.querySelector('#addFloorError').textContent
    };
  })()`);

  confirmar(!estado.semPavimento,
    `o pavimento deveria ter sido cadastrado (erro na tela: "${estado.erroNaTela}")`);
  confirmar(String(estado.desenho).startsWith('blob:'),
    `o desenho deveria aparecer, e veio "${estado.desenho}" (erro: "${estado.erroNaTela}")`);
  confirmar(estado.binario, 'o binário tem de ir para o IndexedDB sob o id do pavimento');
  confirmar(estado.naFila, 'a planta tem de entrar na fila de envio');
  confirmar(estado.origem, 'e ganhar marca de origem, que é o que a protege na fusão');
  igual(estado.largura, 1800, 'com as medidas do rasterizador');
  igual(estado.arquivo, 'N644-23-LOIM-0001-03S-HO-R00.pdf', 'e o nome do arquivo escolhido');

  await ctx.eval('sincronizarComServidor()');
  await pausa(900);
  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get(estado.id).planta_r2_key,
    'e o binário tem de chegar ao servidor'
  );
  ctx.fechar();
});

teste('planta cadastrada pelo diálogo não cai ao mexer no pavimento', async () => {
  /* O sintoma, reproduzido: cadastra com planta, faz qualquer coisa, some.

     "Qualquer coisa" aqui é demarcar e gravar — e depois três sincronizações,
     uma delas completa. O sumiço acontecia na primeira descida que trouxesse o
     pavimento de volta, então repetir é parte do teste: um ciclo só poderia
     passar por sorte de o delta não ter incluído aquele registro. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(ctx);
  await cadastrarPavimentoComPlanta(ctx);

  const antes = await ctx.eval('projects[0].floorPlans[0].planImage || ""');
  confirmar(String(antes).startsWith('blob:'), 'pré-condição: a planta aparece ao cadastrar');

  await ctx.eval('sincronizarComServidor()');
  await pausa(900);

  await ctx.eval(`(() => {
    const pav = projects[0].floorPlans[0];
    pav.regions.push({
      id: 'set-novo', name: 'Setor A', status: 'executed',
      points: [{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }], area: 25
    });
    syncProjectStats(projects[0]);
    saveState();
  })()`);

  await ctx.eval('sincronizarComServidor()');
  await pausa(800);
  await ctx.eval('sincronizarComServidor()');
  await pausa(800);
  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(900);

  const depois = await ctx.eval(`(() => {
    const pav = projects[0].floorPlans[0];
    return { desenho: pav.planImage || '', setores: pav.regions.length, noServidor: Boolean(pav.temPlanta) };
  })()`);

  confirmar(String(depois.desenho).startsWith('blob:'),
    `a planta caiu depois de demarcar e sincronizar — "${depois.desenho}"`);
  confirmar(depois.noServidor, 'e o estado tem de saber que ela está no servidor');
  igual(depois.setores, 1, 'a demarcação continua lá');
  ctx.fechar();
});

teste('planta cadastrada pelo diálogo aparece para o colega', async () => {
  /* O segundo pedido: "quando eu coloco a planta, ela aparece para todos."

     Antes não aparecia para ninguém — nada a enviava. Dois usuários distintos,
     não dois aparelhos do mesmo login, porque é assim que a obra funciona. */
  const { api } = servidorDeTeste();
  const admin = await boot({ api });
  admin.__api = api;
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(admin);
  await cadastrarPavimentoComPlanta(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(900);

  const colega = await criarColegaComSenhaPropria(admin, {
    nome: 'Nicolas', usuario: 'nicolas', provisoria: 'provisoria123', definitiva: 'senhadele456'
  });
  await pausa(1500);

  const vista = await colega.eval(`(async () => {
    const obra = projects.find((p) => p.id === 'obra-1');
    const pav = obra && obra.floorPlans[0];
    if (!pav) return { achou: false };
    return {
      achou: true,
      desenho: pav.planImage || '',
      arquivo: pav.planFileName || '',
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id))
    };
  })()`);

  confirmar(vista.achou, 'o colega deveria ter recebido o pavimento');
  confirmar(String(vista.desenho).startsWith('blob:'),
    `o colega deveria ver a planta, e tem "${vista.desenho}"`);
  confirmar(vista.binario, 'e o binário tem de ficar no aparelho dele, para abrir sem sinal');
  igual(vista.arquivo, 'N644-23-LOIM-0001-03S-HO-R00.pdf', 'com o nome do arquivo de origem');
  admin.fechar();
  colega.fechar();
});

teste('planta do diálogo sobrevive a demarcar e renomear o setor', async () => {
  /* O fluxo pedido, com o formulário de verdade.

     `saveRegionData` não encosta em `planImage` — mas chama `saveState()`, que
     agenda a sincronização, e era na fusão que o desenho caía. Renomear um
     setor quebrava pela MESMA causa, e por isso merece teste próprio: passa
     por `openRegionEditor`, pelo formulário e por `renderSketch()`.

     Confere as duas coisas, e as duas importam. Que o rename ACONTECEU — sem
     isso o teste passaria com um submit que não fez nada, que é a armadilha
     em que o teste vizinho do croqui cai, porque ele só olha a planta. E que a
     planta continua no estado, no SVG e no armazenamento. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(ctx);
  await cadastrarPavimentoComPlanta(ctx, { largura: 1200, altura: 800 });
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);

  async function plantaViva(etapa) {
    const visto = await ctx.eval(`(async () => {
      const pav = projects[0].floorPlans[0];
      const img = document.querySelector('#planBackground');
      return {
        estado: pav.planImage || '',
        href: img ? img.getAttribute('href') : null,
        visivel: img ? img.getAttribute('visibility') : null,
        binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
        erro: document.querySelector('#sketchError').textContent
      };
    })()`);
    confirmar(String(visto.estado).startsWith('blob:'),
      `${etapa}: a planta sumiu do estado — "${visto.estado}" (erro na tela: "${visto.erro}")`);
    confirmar(visto.binario, `${etapa}: o binário sumiu do aparelho`);
    igual(visto.href, visto.estado, `${etapa}: o desenho saiu do SVG`);
    igual(visto.visivel, 'visible', `${etapa}: o desenho ficou oculto`);
  }

  await ctx.eval(`(() => { sketchProjectId = 'obra-1'; sketchFloorIndex = 0; renderSketch(); })()`);
  await pausa(250);
  await plantaViva('logo após cadastrar pelo diálogo');

  /* 1. Demarcar a área. */
  await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-x', name: 'SETOR 1', status: 'pending',
      points: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }], area: 12.5
    });
    selectedRegionId = 'set-x';
    saveState();
    renderSketch();
  })()`);
  await pausa(300);
  await plantaViva('após demarcar');

  /* 2. Renomear pelo formulário real. As coordenadas são postas à mão num
        retângulo sabidamente válido: o objetivo aqui é exercitar a gravação,
        não a validação de geometria, que tem teste próprio. */
  await ctx.eval(`openRegionEditor('obra-1', 0, 'set-x')`);
  await pausa(250);
  await ctx.eval(`(() => {
    document.querySelector('#regionName').value = 'ÁREA RENOMEADA';
    document.querySelector('#regionAreaInput').value = '12,5';
    document.querySelector('#regionXInput').value = '10';
    document.querySelector('#regionYInput').value = '10';
    document.querySelector('#regionWidthInput').value = '30';
    document.querySelector('#regionHeightInput').value = '30';
  })()`);
  ctx.submit('#regionForm');
  await pausa(500);

  const setor = await ctx.eval(`(() => {
    const r = projects[0].floorPlans[0].regions.find((i) => i.id === 'set-x');
    return { nome: r ? r.name : '(sumiu)', erro: document.querySelector('#regionFormError').textContent };
  })()`);
  igual(setor.nome, 'ÁREA RENOMEADA',
    `o setor deveria ter sido renomeado (erro no formulário: "${setor.erro}")`);
  await ctx.eval('renderSketch()');
  await pausa(250);
  await plantaViva('após renomear o setor');

  /* 3. E depois de sincronizar, que é quando o desenho caía de verdade. */
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);
  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(900);
  await ctx.eval('renderSketch()');
  await pausa(250);
  await plantaViva('após renomear e sincronizar');
  ctx.fechar();
});

teste('o botão Fotos abre o local, com câmera e importação', async () => {
  /* O relato: "clico em Fotos, seleciono o local e não consigo tirar foto."

     A ferramenta "Fotos" tem `data-paint=""`, e por isso caía no mesmo caminho
     das cores: `paintRegion` recebia situação vazia, parava na própria guarda
     sem pintar, e o `return` seguinte pulava até o redesenho dos botões. Com um
     setor selecionado — o caso normal, porque tocar na área já o seleciona —
     clicar em "Fotos" não fazia NADA: nem abria o local, nem acendia o botão.

     O resto do caminho já existia e está íntegro; o que faltava era chegar
     nele. Por isso o teste confere o diálogo aberto E os dois caminhos de
     imagem, incluindo o `capture` que é o que faz o celular abrir a câmera
     traseira em vez da galeria. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(ctx);
  await cadastrarPavimentoComPlanta(ctx, { largura: 1200, altura: 800 });

  await ctx.eval(`(() => {
    sketchProjectId = 'obra-1';
    sketchFloorIndex = 0;
    projects[0].floorPlans[0].regions.push({
      id: 'set-x', name: 'SETOR 1', status: 'executed',
      points: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }], area: 12.5
    });
    /* Tocar na área já deixa o setor selecionado: é esse estado que matava o
       botão, então é exatamente nele que o teste precisa estar. */
    selectedRegionId = 'set-x';
    saveState();
    renderSketch();
  })()`);
  await pausa(300);

  await ctx.eval(`(() => {
    document.querySelector('[data-paint=""]').dispatchEvent(new window.Event('click', { bubbles: true }));
  })()`);
  await pausa(400);

  const painel = await ctx.eval(`(() => {
    const dialog = document.querySelector('#localDialog');
    const camera = document.querySelector('#localCameraInput');
    const arquivo = document.querySelector('#localFileInput');
    return {
      aberto: Boolean(dialog && dialog.open),
      titulo: document.querySelector('#localTitle').textContent,
      botaoCamera: Boolean(document.querySelector('label[for="localCameraInput"]')),
      botaoArquivo: Boolean(document.querySelector('label[for="localFileInput"]')),
      capture: camera ? camera.getAttribute('capture') : null,
      aceitaImagem: camera ? camera.getAttribute('accept') : null,
      varios: arquivo ? arquivo.hasAttribute('multiple') : false
    };
  })()`);

  confirmar(painel.aberto, 'clicar em Fotos com uma área selecionada tem de abrir o local');
  igual(painel.titulo, 'SETOR 1', 'e abrir o local certo');
  confirmar(painel.botaoCamera, 'o botão de câmera tem de estar na tela');
  confirmar(painel.botaoArquivo, 'e o de escolher do dispositivo também');
  igual(painel.capture, 'environment', 'a câmera traseira é a que interessa na obra');
  igual(painel.aceitaImagem, 'image/*', 'e o seletor aceita imagem');
  confirmar(painel.varios, 'importar do aparelho aceita várias de uma vez');

  /* E a foto escolhida vira prévia de verdade, pronta para confirmar.

     `compressPhoto` é trocado pela mesma razão que `rasterizePlanFile` nos
     outros testes: ele desenha num canvas, que o jsdom não tem, e a promessa
     ficaria pendurada para sempre em vez de falhar. O que interessa aqui é o
     passo DEPOIS dele — a imagem virar prévia aguardando confirmação. */
  await ctx.eval(`(() => {
    compressPhoto = async () => ${JSON.stringify(JPEG_1X1)};
  })()`);
  await ctx.eval(`(async () => {
    const blob = window.NBZMidia.dataUriParaBlob(${JSON.stringify(JPEG_1X1)});
    const arquivo = new window.File([blob], 'obra.jpg', { type: 'image/jpeg' });
    await addLocalPhotos([arquivo]);
  })()`);
  await pausa(400);

  const prévia = await ctx.eval('pendingLocalPhotos.length');
  igual(prévia, 1, 'a imagem escolhida deveria virar prévia aguardando confirmação');
  ctx.fechar();
});

teste('o relatório desenha as demarcações sobre a planta', async () => {
  /* O relato: "as demarcações e as imagens deram certo, mas no relatório não
     aparece a demarcação que fiz."

     O relatório mostrava a planta como `<img>` cru e os setores numa tabela ao
     lado. Quem lê via "SETOR 1 · 0,8 m²" sem saber ONDE é — que é exatamente o
     que um laudo de impermeabilização precisa mostrar.

     O teste confere o desenho E o alinhamento. O alinhamento importa tanto
     quanto o desenho: setor marcado no lugar errado é pior que setor nenhum,
     porque parece informação boa. Por isso a `viewBox` é comparada com os
     limites que a planta ocupa, que é o espaço em que os pontos vivem. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraVazia(ctx);
  await cadastrarPavimentoComPlanta(ctx, { largura: 1200, altura: 800 });

  await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions.push(
      { id: 'set-a', name: 'SETOR 1', status: 'executed',
        points: [{ x: 150, y: 120 }, { x: 300, y: 120 }, { x: 300, y: 260 }, { x: 150, y: 260 }], area: 0.8 },
      { id: 'set-b', name: 'SETOR 2', status: 'blocked',
        points: [{ x: 400, y: 150 }, { x: 520, y: 150 }, { x: 520, y: 280 }, { x: 400, y: 280 }], area: 0.16 }
    );
    syncProjectStats(projects[0]);
    saveState();
    renderReports();
  })()`);
  await pausa(400);

  const visto = await ctx.eval(`(() => {
    const svg = document.querySelector('#reportContent .rf-plan-overlay');
    const floor = projects[0].floorPlans[0];
    const b = getPlanBounds(floor);
    return {
      temSvg: Boolean(svg),
      viewBox: svg ? svg.getAttribute('viewBox') : '',
      esperado: [b.x, b.y, b.width, b.height].join(' '),
      poligonos: svg ? svg.querySelectorAll('polygon').length : 0,
      rotulos: svg ? Array.from(svg.querySelectorAll('text')).map((t) => t.textContent) : [],
      imgContinua: Boolean(document.querySelector('#reportContent .rf-plan img')),
      preenchimentos: svg ? Array.from(svg.querySelectorAll('polygon')).map((p) => p.getAttribute('fill')) : []
    };
  })()`);

  confirmar(visto.temSvg, 'o relatório deveria ter a camada de setores sobre a planta');
  igual(visto.poligonos, 2, 'um polígono por setor demarcado');
  igual(visto.viewBox, visto.esperado,
    'a viewBox tem de ser o retângulo da planta, senão os setores saem deslocados');
  confirmar(visto.rotulos.includes('SETOR 1') && visto.rotulos.includes('SETOR 2'),
    `os setores deveriam estar rotulados, e vieram ${JSON.stringify(visto.rotulos)}`);

  /* O `<img>` tem de continuar existindo: `loadReportImages()` espera por
     `#reportContent img` antes de imprimir, e sem a tag a planta sai em branco
     no papel. */
  confirmar(visto.imgContinua, 'a planta tem de seguir como <img>, por causa da impressão');

  /* Cores diferentes para situações diferentes: é o que faz o laudo mostrar o
     que está pronto e o que está travado sem precisar cruzar com a tabela. */
  confirmar(visto.preenchimentos[0] !== visto.preenchimentos[1],
    `cada situação tem sua cor, e vieram ${JSON.stringify(visto.preenchimentos)}`);

  /* Pavimento sem medidas de planta não ganha camada: sem aspecto conhecido o
     desenho cairia no lugar errado, e errado é pior que ausente. */
  const semMedidas = await ctx.eval(`(() => {
    projects[0].floorPlans[0].planWidth = 0;
    projects[0].floorPlans[0].planHeight = 0;
    renderReports();
    return Boolean(document.querySelector('#reportContent .rf-plan-overlay'));
  })()`);
  confirmar(!semMedidas, 'sem as medidas da planta, melhor não desenhar do que desenhar torto');
  ctx.fechar();
});

teste('a planta se mantém igual vinda de JPEG ou de PDF', async () => {
  /* O PDF nunca chega ao servidor como PDF: `rasterizePlanFile` renderiza a
     primeira página num canvas e entrega JPEG, exatamente como faz com imagem.
     Depois do rasterizador os dois caminhos são o MESMO caminho — e é isso que
     este teste fixa, para ninguém "otimizar" mandando o PDF cru adiante.

     O que muda entre eles é só a origem do desenho, e isso fica no nome do
     arquivo, que é informativo. */
  const { api, db } = servidorDeTeste();

  for (const arquivo of ['planta-terreo.jpg', 'planta-terreo.pdf']) {
    const ctx = await boot({ api });
    await pausa(600);
    if (arquivo.endsWith('.jpg')) {
      await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
    } else {
      await preencherLogin(ctx, { usuario: 'richard', senha: 'senhaforte1' });
      await pausa(1200);
    }
    await criarObraComFoto(ctx);
    await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
    await importarPelaTela(ctx, { arquivo });
    await ctx.eval('sincronizarComServidor()');
    await pausa(900);

    const pavimento = db.prepare(
      'select planta_r2_key, planta_arquivo, planta_largura from pavimentos where id = ?'
    ).get('pav-1');
    confirmar(pavimento.planta_r2_key, `${arquivo}: a planta deveria ter subido`);
    confirmar(/\.jpg$/.test(pavimento.planta_r2_key),
      `${arquivo}: o objeto no bucket é JPEG nos dois casos, e é "${pavimento.planta_r2_key}"`);
    igual(pavimento.planta_arquivo, arquivo, `${arquivo}: o nome de origem é preservado`);
    igual(pavimento.planta_largura, 1200, `${arquivo}: com as medidas do rasterizador`);

    confirmar(
      String(await ctx.eval('projects[0].floorPlans[0].planImage')).startsWith('blob:'),
      `${arquivo}: e o desenho fica visível no aparelho`
    );
    ctx.fechar();
  }
});

teste('o servidor recusa PDF cru, porque quem rasteriza é o painel', async () => {
  /* Guarda do contrato: se um dia alguém mandar o arquivo original em vez do
     desenho rasterizado, o servidor recusa com 415 em vez de guardar um PDF que
     nenhuma tela sabe desenhar. `tipoReal` confere a assinatura do arquivo, e
     não o cabeçalho informado por quem envia. */
  const { env, db } = servidorDeTeste();
  db.prepare('insert into obras (id, nome) values (?, ?)').run('obra-1', 'M');
  db.prepare('insert into pavimentos (id, obra_id, nome) values (?, ?, ?)').run('pav-1', 'obra-1', 'Térreo');

  /* "%PDF-1.4" seguido de enchimento: assinatura real de PDF. */
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0, 0, 0, 0, 0, 0, 0]);
  const recusado = await fotos.enviarPlanta(
    env, { id: 'u1', nivelAcesso: 'administrador' },
    {
      headers: { get: (n) => (String(n).toLowerCase() === 'content-length' ? String(pdf.length) : null) },
      arrayBuffer: () => Promise.resolve(pdf.buffer.slice(0))
    },
    new URLSearchParams({ pavimento: 'pav-1' })
  );

  igual(recusado.status, 415, 'PDF cru deveria ser recusado');
  confirmar(/JPG, PNG ou WEBP/.test(recusado.erro), `a mensagem deveria dizer o que aceita, e diz "${recusado.erro}"`);
  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'e nada pode ter sido gravado'
  );
});

teste('desenho que falha ao carregar é recuperado do armazenamento', async () => {
  /* Rede de segurança para a classe inteira de sumiço que não consegui
     reproduzir: o object URL morre — revogado, ou descartado pelo navegador sob
     pressão de memória, coisa que o Safari do iPhone faz com imagem grande — e
     `planImage` continua parecendo certo enquanto a tela fica vazia. É o sintoma
     mais difícil de diagnosticar: estado correto, planta invisível.

     O binário está no IndexedDB, então refazer o endereço resolve sem precisar
     descobrir qual das causas foi. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await pausa(400);
  const original = await ctx.eval('projects[0].floorPlans[0].planImage');
  confirmar(String(original).startsWith('blob:'), 'pré-condição: o desenho está lá');

  /* Mata o endereço como o navegador faria, e dispara o erro de carregamento. */
  await ctx.eval(`(async () => {
    window.NBZMidia.liberarUrlDaPlanta('pav-1');
    const img = document.querySelector('#planBackground');
    img.dispatchEvent(new window.Event('error'));
  })()`);
  await pausa(600);

  const depois = await ctx.eval(`(() => {
    const img = document.querySelector('#planBackground');
    return {
      estado: projects[0].floorPlans[0].planImage || '',
      href: img.getAttribute('href') || '',
      visivel: img.getAttribute('visibility')
    };
  })()`);

  confirmar(String(depois.estado).startsWith('blob:'),
    `o desenho deveria ter sido recuperado, e está "${depois.estado}"`);
  igual(depois.href, depois.estado, 'e reaplicado no SVG');
  igual(depois.visivel, 'visible', 'e visível');
  confirmar(depois.estado !== original,
    'com endereço NOVO: reaproveitar o que falhou não recuperaria nada');
  ctx.fechar();
});

teste('concluir o polígono pelo fluxo real não faz a planta sumir', async () => {
  /* O relato: a planta aparece ao importar e some ao DEMARCAR.

     Todos os testes anteriores empurravam o setor direto em `regions` — nunca
     passavam por `finishSketchRegion()`, que é o que roda ao concluir o
     polígono. Essa função faz muito mais: valida limites, recalcula estatísticas,
     grava, redesenha, chama `renderAll()` e abre o editor de setor como um
     SEGUNDO diálogo modal sobre o croqui. Qualquer um desses passos pode levar
     o desenho junto, e nenhum estava coberto. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await pausa(400);

  const antes = await ctx.eval(`(() => {
    const img = document.querySelector('#planBackground');
    return { estado: projects[0].floorPlans[0].planImage || '', href: img ? img.getAttribute('href') : '', visivel: img ? img.getAttribute('visibility') : '' };
  })()`);
  confirmar(String(antes.estado).startsWith('blob:'), 'pré-condição: a planta aparece ao importar');
  igual(antes.href, antes.estado, 'pré-condição: e está desenhada no SVG');

  /* Agora o caminho REAL: pontos marcados no croqui e "Concluir polígono".
     Os pontos ficam dentro do retângulo da planta (100,80 a 900,560) para passar
     na validação de limites. O setor existente de `criarObraComFoto` é removido
     antes, senão a nova demarcação cruza com ele e é recusada. */
  const resultado = await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions = [];
    projects[0].floorPlans[0].area = 500;
    sketchPoints = [{x:200,y:150},{x:400,y:150},{x:400,y:300},{x:200,y:300}];
    document.querySelector('#regionStatus').value = 'executed';
    finishSketchRegion();
    const img = document.querySelector('#planBackground');
    return {
      setores: projects[0].floorPlans[0].regions.length,
      estado: projects[0].floorPlans[0].planImage || '',
      href: img ? img.getAttribute('href') : '',
      visivel: img ? img.getAttribute('visibility') : '',
      erro: document.querySelector('#sketchError').textContent
    };
  })()`);

  igual(resultado.setores, 1, `a demarcação deveria ter sido criada (erro: "${resultado.erro}")`);
  confirmar(String(resultado.estado).startsWith('blob:'),
    `a planta sumiu do estado ao concluir o polígono — "${resultado.estado}"`);
  igual(resultado.href, resultado.estado,
    'o desenho saiu do SVG ao concluir o polígono');
  igual(resultado.visivel, 'visible', 'o desenho ficou oculto ao concluir o polígono');

  /* E depois que o editor de setor que ele abre é fechado. */
  await ctx.eval(`(() => {
    const d = document.querySelector('#regionDialog');
    if (d && d.open) d.close();
    renderSketch();
  })()`);
  await pausa(300);
  const depois = await desenhoNaTela(ctx);
  confirmar(String(depois.estado).startsWith('blob:'),
    `a planta sumiu depois de fechar o editor de setor — "${depois.estado}"`);
  igual(depois.href, depois.estado, 'e saiu do SVG');
  confirmar(depois.binario, 'e o binário sumiu do aparelho');
  ctx.fechar();
});

/* ------------------------- caça às sumiços da planta ------------------- */

/* Lê o que o olho veria, para reusar entre os testes desta seção. */
async function desenhoNaTela(ctx, indice = 0) {
  return ctx.eval(`(async () => {
    const pav = projects[0].floorPlans[${indice}];
    if (!pav) return { existe: false };
    const img = document.querySelector('#planBackground');
    return {
      existe: true,
      estado: pav.planImage || '',
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
      href: img ? (img.getAttribute('href') || '') : '',
      visivel: img ? img.getAttribute('visibility') : null
    };
  })()`);
}

teste('com TODOS os cargos ativos ao mesmo tempo, a planta não some em ninguém', async () => {
  /* O cenário de obra: várias pessoas com o painel aberto, sincronizando em
     momentos diferentes. É aqui que a planta já sumiu — um aparelho empurrava
     estado sem o desenho e a fusão do outro apagava.

     Cada usuário é de um cargo, num aparelho próprio, e todos sincronizam
     várias vezes intercalados. Ao fim, a planta tem de estar viva em TODOS. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  admin.__api = api;
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(admin);
  await admin.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(800);
  confirmar(db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'pré-condição: a planta está no servidor');

  /* Os quatro outros cargos entram, um aparelho cada. O cliente entra junto
     apesar de não gravar nada: ele LÊ e sincroniza, e sincronização que apaga a
     planta não pergunta o cargo de quem sincronizou. */
  const colegas = [];
  for (const cargo of ['engenheiro', 'encarregado', 'tecnico', 'cliente']) {
    colegas.push({
      cargo,
      ctx: await criarColegaComSenhaPropria(admin, {
        nome: `Pessoa ${cargo}`, usuario: `muitos_${cargo}`,
        provisoria: 'provisoria123', definitiva: `senha_${cargo}_7`, cargo
      })
    });
  }

  /* Todos baixam. */
  for (const { cargo, ctx } of colegas) {
    await ctx.eval('sincronizarComServidor({ apenasBaixar: true })');
    await pausa(1500);
    const v = await ctx.eval(`(async () => {
      const obra = projects.find((p) => p.id === 'obra-1');
      const pav = obra && obra.floorPlans[0];
      return pav ? { estado: pav.planImage || '', binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)) } : { estado: '', binario: false };
    })()`);
    confirmar(String(v.estado).startsWith('blob:'), `${cargo}: não recebeu a planta`);
    confirmar(v.binario, `${cargo}: recebeu a referência mas não o binário`);
  }

  /* Agora o vaivém: cada um grava algo e sincroniza, intercalado com os outros.
     O técnico só pode mudar situação, então é o que ele faz. */
  for (let rodada = 1; rodada <= 3; rodada += 1) {
    for (const { cargo, ctx } of colegas) {
      /* O cliente não grava — o servidor recusa com 403 e é assim que deve ser.
         Ele participa sincronizando, que é o que o cargo dele faz. */
      if (cargo === 'cliente') {
        await ctx.eval('sincronizarComServidor({ apenasBaixar: true })');
        await pausa(300);
        continue;
      }
      await ctx.eval(`(() => {
        const obra = projects.find((p) => p.id === 'obra-1');
        const setor = obra.floorPlans[0].regions[0];
        if (setor) setor.status = '${rodada % 2 ? 'inProgress' : 'executed'}';
        saveState();
      })()`);
      await ctx.eval('sincronizarComServidor()');
      await pausa(300);
    }
    await admin.eval('sincronizarComServidor()');
    await pausa(300);

    /* Depois de cada rodada, a planta tem de estar viva em todos. */
    for (const { cargo, ctx } of [{ cargo: 'administrador', ctx: admin }, ...colegas]) {
      const v = await ctx.eval(`(async () => {
        const obra = projects.find((p) => p.id === 'obra-1');
        const pav = obra && obra.floorPlans[0];
        return pav ? { estado: pav.planImage || '', binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)) } : { estado: '', binario: false };
      })()`);
      confirmar(String(v.estado).startsWith('blob:'),
        `rodada ${rodada}, ${cargo}: a planta sumiu — "${v.estado}"`);
      confirmar(v.binario, `rodada ${rodada}, ${cargo}: o binário sumiu`);
    }
  }

  /* E continua no servidor no fim de tudo. */
  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'a planta tem de continuar no servidor depois de todo o vaivém'
  );

  admin.fechar();
  for (const { ctx } of colegas) ctx.fechar();
});

teste('dois pavimentos com plantas diferentes não trocam de desenho', async () => {
  /* Cenário nunca exercitado: duas plantas no mesmo projeto. Como o armazenamento
     é por id de pavimento e o object URL fica em cache por chave, basta uma
     confusão de chave para o Térreo mostrar a planta do 2º andar — e ninguém
     perceberia, porque AMBOS mostram alguma planta. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  await ctx.eval(`(() => {
    projects[0].floorPlans.push({
      id: 'pav-2', name: '2º pavimento', area: 80, regions: [],
      planImage: '', planWidth: 0, planHeight: 0, planFileName: ''
    });
    saveState();
  })()`);

  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx, { arquivo: 'terreo.jpg', largura: 1000, altura: 700 });
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 1;');
  await importarPelaTela(ctx, { arquivo: 'segundo.jpg', largura: 1400, altura: 900 });
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);

  const t = await ctx.eval('JSON.stringify(projects[0].floorPlans.map((f) => ({ id: f.id, img: f.planImage, arq: f.planFileName, larg: f.planWidth })))');
  const plantas = JSON.parse(t);
  confirmar(plantas[0].img && plantas[0].img.startsWith('blob:'), 'o térreo deveria ter planta');
  confirmar(plantas[1].img && plantas[1].img.startsWith('blob:'), 'o 2º pavimento também');
  confirmar(plantas[0].img !== plantas[1].img,
    'e os desenhos têm de ser DIFERENTES — o mesmo endereço nos dois significaria planta trocada');
  igual(plantas[0].arq, 'terreo.jpg', 'cada um com o arquivo que recebeu');
  igual(plantas[1].arq, 'segundo.jpg', 'idem');
  igual([plantas[0].larg, plantas[1].larg], [1000, 1400], 'e com as medidas próprias');
  ctx.fechar();
});

teste('excluir um pavimento não apaga a planta do outro', async () => {
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval(`(() => {
    projects[0].floorPlans.push({
      id: 'pav-2', name: '2º pavimento', area: 80, regions: [],
      planImage: '', planWidth: 0, planHeight: 0, planFileName: ''
    });
    saveState();
  })()`);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx, { arquivo: 'terreo.jpg' });
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);
  const antes = await ctx.eval('projects[0].floorPlans[0].planImage');

  /* Exclui o SEGUNDO pavimento, que não tem planta. */
  ctx.window.confirm = () => true;
  await ctx.eval('deleteProjectFloor("obra-1", 1)');
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);

  igual(await ctx.eval('projects[0].floorPlans.length'), 1, 'sobra um pavimento');
  const depois = await desenhoNaTela(ctx);
  igual(depois.estado, antes, 'e a planta do que sobrou tem de ser a mesma');
  confirmar(depois.binario, 'com o binário intacto');
  ctx.fechar();
});

teste('a planta sobrevive a dez sincronizações seguidas', async () => {
  /* A busca periódica roda de minuto em minuto. Num dia de trabalho são
     centenas de ciclos, e basta um deles apagar a planta para o engenheiro
     perder o desenho no meio da visita. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  for (let i = 1; i <= 10; i += 1) {
    await ctx.eval('sincronizarComServidor({ apenasBaixar: true })');
    await pausa(150);
    const v = await desenhoNaTela(ctx);
    confirmar(String(v.estado).startsWith('blob:'), `sumiu na ${i}ª sincronização`);
    confirmar(v.binario, `binário sumiu na ${i}ª sincronização`);
  }
  ctx.fechar();
});

teste('a planta sobrevive a uma descida completa', async () => {
  /* `completo: true` ignora a marca e traz a base inteira — é o que roda ao
     entrar num aparelho. Pacote cheio percorre caminhos da fusão que o delta
     não percorre. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(800);
  const v = await desenhoNaTela(ctx);
  confirmar(String(v.estado).startsWith('blob:'), `sumiu na descida completa — "${v.estado}"`);
  confirmar(v.binario, 'e o binário sumiu junto');
  ctx.fechar();
});

teste('a planta sobrevive a sair e entrar de novo', async () => {
  /* Sair limpa a sessão; entrar dispara descida completa. O binário mora no
     IndexedDB, que não é limpo no logout — então tem de reaparecer. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  ctx.doc.querySelector('#logoutButton').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await pausa(700);
  await preencherLogin(ctx, { usuario: 'richard', senha: 'senhaforte1' });
  await pausa(1700);

  const v = await ctx.eval(`(async () => {
    const obra = projects.find((p) => p.id === 'obra-1');
    const pav = obra && obra.floorPlans[0];
    return pav ? {
      estado: pav.planImage || '',
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id))
    } : { estado: '', binario: false };
  })()`);
  confirmar(String(v.estado).startsWith('blob:'), `sumiu depois de sair e entrar — "${v.estado}"`);
  confirmar(v.binario, 'e o binário sumiu junto');
  ctx.fechar();
});

teste('sem IndexedDB a planta ainda aparece, pelo caminho de reserva', async () => {
  /* Modo privado de alguns navegadores e origem não segura bloqueiam o
     IndexedDB. A camada de mídia degrada para data-URI no localStorage — e o
     desenho PRECISA aparecer mesmo assim, senão quem está nessa situação fica
     sem planta e sem explicação. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api, comIndexedDB: false });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await pausa(400);

  const estado = await ctx.eval('projects[0].floorPlans[0].planImage');
  confirmar(String(estado).startsWith('data:'),
    `sem IndexedDB o desenho deveria ficar como data-URI, e ficou "${String(estado).slice(0, 24)}"`);
  const href = await ctx.eval("document.querySelector('#planBackground').getAttribute('href')");
  igual(href, estado, 'e o SVG tem de apontar para ele');
  ctx.fechar();
});

teste('a planta sobrevive a tudo que o croqui oferece', async () => {
  /* Varredura do que existe na tela da planta, uma ação por vez, conferindo o
     desenho depois de CADA uma. A pergunta é sempre a mesma — a planta sumiu? —
     e aqui ela é feita após demarcar, pintar, editar dados do setor, fotografar,
     dar zoom, desfazer, limpar o desenho em andamento e excluir a demarcação.

     Verifica o SVG e o binário juntos: o estado pode estar certo e a tela não,
     ou o contrário. Já aconteceram os dois. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  /* Lê o que o olho veria: o <image> do SVG, mais o binário guardado. */
  async function plantaSegueAhi(ctx, etapa) {
    const visto = await ctx.eval(`(async () => {
      const pav = projects[0].floorPlans[0];
      const img = document.querySelector('#planBackground');
      return {
        estado: pav.planImage,
        href: img ? img.getAttribute('href') : null,
        visivel: img ? img.getAttribute('visibility') : null,
        binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
        erro: document.querySelector('#sketchError').textContent
      };
    })()`);
    confirmar(String(visto.estado).startsWith('blob:'),
      `${etapa}: a planta sumiu do estado — "${visto.estado}" (erro na tela: "${visto.erro}")`);
    confirmar(visto.binario, `${etapa}: o binário sumiu do aparelho`);
    igual(visto.href, visto.estado, `${etapa}: o desenho saiu do SVG`);
    igual(visto.visivel, 'visible', `${etapa}: o desenho ficou oculto`);
  }

  await plantaSegueAhi(ctx, 'logo após importar');

  /* 1. Demarcar uma área. */
  await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-x', name: 'SETOR 1', status: 'pending',
      points: [{x:10,y:10},{x:40,y:10},{x:40,y:40},{x:10,y:40}], area: 12.5
    });
    selectedRegionId = 'set-x';
    saveState();
    renderSketch();
  })()`);
  await pausa(300);
  await plantaSegueAhi(ctx, 'após demarcar');

  /* 2. Trocar a cor (situação) da área demarcada. */
  for (const situacao of ['executed', 'inProgress', 'blocked', 'pending']) {
    await ctx.eval(`(() => {
      selectedRegionId = 'set-x';
      document.querySelector('[data-paint="${situacao}"]').dispatchEvent(new window.Event('click', { bubbles: true }));
    })()`);
    await pausa(250);
    await plantaSegueAhi(ctx, `após pintar ${situacao}`);
  }

  /* 3. Editar os dados do setor pelo formulário. */
  await ctx.eval(`(() => {
    selectedRegionId = 'set-x';
    const def = { regionName: 'SETOR RENOMEADO', regionMaterial: 'Manta', regionSystem: 'Asfáltica' };
    for (const [id, valor] of Object.entries(def)) {
      const campo = document.querySelector('#' + id);
      if (campo) campo.value = valor;
    }
  })()`);
  await ctx.eval(`(() => {
    const form = document.querySelector('#regionForm');
    if (form) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await pausa(400);
  await plantaSegueAhi(ctx, 'após editar dados do setor');

  /* 4. Zoom e enquadramento. */
  for (const acao of ['in', 'out', 'reset']) {
    await ctx.eval(`(() => {
      const b = document.querySelector('[data-plan-zoom="${acao}"]');
      if (b) b.dispatchEvent(new window.Event('click', { bubbles: true }));
    })()`);
    await pausa(200);
    await plantaSegueAhi(ctx, `após zoom ${acao}`);
  }

  /* 5. Abrir as fotografias do local e registrar uma. */
  const achouFoto = await ctx.eval(`(() => {
    const b = document.querySelector('[data-sketch-action="photo"]');
    if (!b) return false;
    b.dispatchEvent(new window.Event('click', { bubbles: true }));
    return true;
  })()`);
  confirmar(achouFoto, 'o botão de fotografias deveria existir na barra do croqui');
  await pausa(400);
  await plantaSegueAhi(ctx, 'após abrir fotografias');

  await ctx.eval(`(async () => {
    const blob = window.NBZMidia.dataUriParaBlob(${JSON.stringify(JPEG_1X1)});
    await window.NBZMidia.guardarFoto('foto-croqui', blob);
    const url = await window.NBZMidia.urlDaFoto('foto-croqui');
    projects[0].photoReports[0].photos.push({
      id: 'foto-croqui', data: url, date: new Date().toISOString(),
      author: 'Richard', includeInReport: true
    });
    saveState();
    renderSketch();
  })()`);
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);
  await plantaSegueAhi(ctx, 'após registrar fotografia e sincronizar');

  /* 6. Desfazer e limpar o desenho em andamento. */
  for (const acao of ['undo', 'clear']) {
    const achou = await ctx.eval(`(() => {
      const b = document.querySelector('[data-sketch-action="${acao}"]');
      if (!b) return false;
      b.dispatchEvent(new window.Event('click', { bubbles: true }));
      return true;
    })()`);
    confirmar(achou, `o botão "${acao}" deveria existir na barra do croqui`);
    await pausa(250);
    await plantaSegueAhi(ctx, `após ${acao}`);
  }

  /* 7. Excluir a demarcação. */
  ctx.window.confirm = () => true;
  await ctx.eval('selectedRegionId = "set-x"; deleteSelectedRegion();');
  await pausa(400);
  await plantaSegueAhi(ctx, 'após excluir a demarcação');

  await ctx.eval('sincronizarComServidor()');
  await pausa(900);
  await plantaSegueAhi(ctx, 'após sincronizar a exclusão da demarcação');

  /* 8. E depois de reabrir o aplicativo. */
  await ctx.eval('(async () => { await prepararMidia(); })()');
  await pausa(500);
  await plantaSegueAhi(ctx, 'após reabrir o aplicativo');

  ctx.fechar();
});

teste('a planta se mantém ao trocar de modo e ao pintar situações', async () => {
  /* O relato: a planta some ao mudar para Finalizado, Executando ou Fotos.

     Cada botão daqueles troca o modo e redesenha o croqui, e pintar uma área
     ainda grava o estado e dispara sincronização — ou seja, percorre o caminho
     onde a planta já sumiu antes. O teste passa por todos os modos e, em cada
     um, confere o desenho E o binário. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  await importarPelaTela(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  /* Demarca uma área para haver o que pintar. */
  await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-pintar', name: 'SETOR 1', status: 'pending',
      points: [{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}], area: 0.71
    });
    selectedRegionId = 'set-pintar';
    saveState();
    renderSketch();
  })()`);
  await pausa(300);

  const modos = [
    ['executed', 'Finalizado'],
    ['inProgress', 'Executando'],
    ['blocked', 'Não Liberado'],
    ['pending', 'Liberado'],
    ['draw', 'Demarcar Áreas'],
    ['', 'Fotos']
  ];

  for (const [valor, rotulo] of modos) {
    /* Clica no botão de verdade, pelo seletor que a tela monta. */
    const clicou = await ctx.eval(`(() => {
      const b = document.querySelector('[data-paint="${valor}"]');
      if (!b) return false;
      b.dispatchEvent(new window.Event('click', { bubbles: true }));
      return true;
    })()`);
    confirmar(clicou, `${rotulo}: o botão deveria existir na barra`);
    await pausa(400);

    const visto = await ctx.eval(`(async () => {
      const pav = projects[0].floorPlans[0];
      const imagem = document.querySelector('#planBackground');
      return {
        desenho: pav.planImage,
        binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
        href: imagem ? imagem.getAttribute('href') : null,
        visivel: imagem ? imagem.getAttribute('visibility') : null
      };
    })()`);

    confirmar(String(visto.desenho).startsWith('blob:'),
      `${rotulo}: a planta deveria continuar no estado, e está "${visto.desenho}"`);
    confirmar(visto.binario, `${rotulo}: o binário deveria continuar no aparelho`);
    /* E, acima de tudo, continuar desenhada: é o <image> do SVG que o olho vê. */
    igual(visto.href, visto.desenho, `${rotulo}: o desenho deveria estar no SVG`);
    igual(visto.visivel, 'visible', `${rotulo}: e marcado como visível`);
  }

  /* Pintar de fato uma situação — grava e sincroniza. */
  await ctx.eval(`(() => {
    const b = document.querySelector('[data-paint="executed"]');
    selectedRegionId = 'set-pintar';
    b.dispatchEvent(new window.Event('click', { bubbles: true }));
  })()`);
  await ctx.eval('sincronizarComServidor()');
  await pausa(800);

  igual(
    await ctx.eval('projects[0].floorPlans[0].regions.find((r) => r.id === "set-pintar").status'),
    'executed', 'a situação pintada deveria ter sido aplicada'
  );
  confirmar(
    String(await ctx.eval('projects[0].floorPlans[0].planImage')).startsWith('blob:'),
    'e a planta tem de sobreviver a pintar situação e sincronizar'
  );
  ctx.fechar();
});

teste('a planta continua visível depois de demarcar sobre ela', async () => {
  /* O relato: importa a planta, demarca uma área, e o desenho de fundo some —
     sobra o setor flutuando sobre o branco.

     Demarcar dispara `saveState()`, que agenda sincronização, que roda a fusão.
     É nesse caminho que a planta já sumiu antes, por mais de um motivo, então o
     teste percorre o ciclo inteiro: importar, demarcar, sincronizar, e conferir
     o desenho E o binário no fim. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  const urlOriginal = await importarPlanta(ctx);
  confirmar(String(urlOriginal).startsWith('blob:'), 'pré-condição: a planta foi importada');

  /* Demarca uma área nova, como o croqui faz ao desenhar. */
  await ctx.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-demarcado', name: 'SETOR 1', status: 'executed',
      points: [{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}], area: 0.71
    });
    saveState();
  })()`);
  await pausa(300);

  const logoDepois = await ctx.eval('projects[0].floorPlans[0].planImage');
  confirmar(String(logoDepois).startsWith('blob:'),
    `logo depois de demarcar a planta já deveria estar visível, e está "${logoDepois}"`);

  /* Agora o ciclo que de fato mexe no estado: sobe e desce. */
  await ctx.eval('sincronizarComServidor()');
  await pausa(900);

  const depoisDoSync = await ctx.eval(`(async () => {
    const pav = projects[0].floorPlans[0];
    return {
      desenho: pav.planImage,
      binario: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
      setores: pav.regions.map((r) => r.id).sort()
    };
  })()`);

  confirmar(String(depoisDoSync.desenho).startsWith('blob:'),
    `depois de sincronizar a planta deveria continuar visível, e está "${depoisDoSync.desenho}"`);
  confirmar(depoisDoSync.binario, 'e o binário tem de continuar no aparelho');
  igual(depoisDoSync.setores, ['set-1', 'set-demarcado'], 'com as duas demarcações');

  /* E depois de recarregar a página, que é quando `reidratarPlantas` entra. */
  await ctx.eval('(async () => { await prepararMidia(); })()');
  await pausa(400);
  confirmar(
    String(await ctx.eval('projects[0].floorPlans[0].planImage')).startsWith('blob:'),
    'e tem de sobreviver ao preparo da mídia, que é o que roda ao reabrir'
  );
  ctx.fechar();
});

teste('planta e demarcação do ADM ficam visíveis em todos os cargos', async () => {
  /* O que o usuário pediu: subir uma planta, demarcar sobre ela, e conferir se a
     planta fica visível para todo mundo.

     "Visível" aqui tem significado preciso e é o que se verifica: o pavimento
     tem o DESENHO no aparelho (object URL apontando para binário gravado), as
     medidas da planta, e a demarcação com a situação certa. Registro sem binário
     mostraria o quadro de imagem quebrada, que já aconteceu em produção. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  admin.__api = api;
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(admin);
  /* Sincroniza ANTES de importar: assim o setor antigo existe no servidor, e dá
     para provar que a limpeza feita pela importação chega lá. */
  await admin.eval('sincronizarComServidor()');
  await pausa(500);
  igual(db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 1,
    'pré-condição: o setor antigo está no servidor');

  await admin.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  /* Pela tela, e não pelo atalho: é `importFloorPlan` que roda quando alguém
     escolhe o arquivo, e é ele que precisa estar certo. Ele limpa as
     demarcações, porque os pontos são percentuais da imagem. */
  await importarPelaTela(admin);

  /* E demarca sobre a planta, que é o passo seguinte do uso real. */
  await admin.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-demarcado', name: 'SETOR 1', status: 'executed',
      points: [{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}], area: 0.71
    });
    saveState();
  })()`);
  await admin.eval('sincronizarComServidor()');
  await pausa(900);

  const pavimento = db.prepare(
    'select planta_r2_key, planta_largura, planta_altura from pavimentos where id = ?'
  ).get('pav-1');
  confirmar(pavimento.planta_r2_key, 'pré-condição: a planta subiu ao servidor');
  igual(pavimento.planta_largura, 1200, 'com as medidas');

  for (const cargo of ['engenheiro', 'encarregado', 'tecnico', 'cliente']) {
    const aparelho = await criarColegaComSenhaPropria(admin, {
      nome: `Pessoa ${cargo}`, usuario: `planta_${cargo}`,
      provisoria: 'provisoria123', definitiva: `senha_${cargo}_9`, cargo
    });
    await aparelho.eval('sincronizarComServidor({ apenasBaixar: true })');
    /* A planta é baixada num segundo passo, depois da descida do estado. */
    await pausa(1600);

    const visto = await aparelho.eval(`(async () => {
      const obra = projects.find((p) => p.id === 'obra-1');
      if (!obra) return { obra: false };
      const pav = obra.floorPlans[0];
      return {
        obra: true,
        temDesenho: String(pav.planImage || '').startsWith('blob:'),
        largura: pav.planWidth,
        temPlantaNoServidor: Boolean(pav.temPlanta),
        binarioGravado: Boolean(await window.NBZMidia.registroDaPlanta(pav.id)),
        setores: pav.regions.map((r) => ({ id: r.id, situacao: r.status }))
      };
    })()`);

    confirmar(visto.obra, `${cargo}: a obra deveria ter chegado`);
    confirmar(visto.temDesenho, `${cargo}: o DESENHO da planta deveria estar visível`);
    confirmar(visto.binarioGravado,
      `${cargo}: o binário da planta deveria estar gravado no aparelho, não só referenciado`);
    igual(visto.largura, 1200, `${cargo}: as medidas da planta deveriam ter chegado`);
    confirmar(visto.temPlantaNoServidor, `${cargo}: o painel deveria saber que há planta no servidor`);
    /* Só a demarcação feita SOBRE a planta nova. A antiga foi limpa pela
       importação, e essa limpeza precisa ter chegado ao servidor — senão ela
       voltaria, com pontos calculados para o desenho anterior. */
    igual(visto.setores.map((s) => s.id), ['set-demarcado'],
      `${cargo}: deveria ver a demarcação nova, e só ela`);

    aparelho.fechar();
  }

  admin.fechar();
});

teste('foto e demarcação do ADM chegam a todos os cargos', async () => {
  /* O que o usuário pediu: registrar fotografia num pavimento, demarcar área, e
     conferir que aparece para todos os usuários e cargos.

     Cada cargo entra num aparelho próprio, com localStorage e IndexedDB vazios —
     só o servidor em comum. O que se verifica em cada um é o que de fato importa
     na obra: a demarcação com a situação certa, e a FOTOGRAFIA com binário no
     armazenamento local (não apenas o registro), porque é ela que precisa abrir
     dentro da obra sem sinal. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  admin.__api = api;
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });

  /* A obra já nasce com setor demarcado e uma fotografia — é o que
     `criarObraComFoto` monta: setor 'set-1' como 'executed' e a foto 'foto-1'. */
  await criarObraComFoto(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(600);

  const foto = db.prepare('select id, relatorio_id, bytes from fotos where excluido_em is null').get();
  confirmar(foto, 'pré-condição: a fotografia subiu para o servidor');
  confirmar(foto.bytes > 0, 'com binário de tamanho real');
  igual(db.prepare('select situacao from setores where id = ?').get('set-1').situacao, 'executed',
    'e a demarcação subiu com a situação aplicada');

  /* Um aparelho por cargo. O cliente entra também: ele consulta relatórios, e
     fotografia que não chega a ele é relatório pela metade. */
  const cargos = ['engenheiro', 'encarregado', 'tecnico', 'cliente'];
  for (const cargo of cargos) {
    const usuario = `pessoa_${cargo}`;
    const aparelho = await criarColegaComSenhaPropria(admin, {
      nome: `Pessoa ${cargo}`, usuario,
      provisoria: 'provisoria123', definitiva: `senha_${cargo}_1`, cargo
    });
    await aparelho.eval('sincronizarComServidor({ apenasBaixar: true })');
    /* Espera generosa: além da descida, o binário da fotografia é baixado num
       segundo passo. */
    await pausa(1600);

    const visto = await aparelho.eval(`(() => {
      const obra = projects.find((p) => p.id === 'obra-1');
      if (!obra) return { obra: false };
      const pavimento = obra.floorPlans[0];
      const relatorio = (obra.photoReports || [])[0];
      const fotografia = relatorio && relatorio.photos && relatorio.photos[0];
      return {
        obra: true,
        setores: pavimento.regions.map((r) => ({ id: r.id, situacao: r.status })),
        relatorioDoPavimento: relatorio ? relatorio.floorId : null,
        fotoId: fotografia ? fotografia.id : null,
        fotoTemImagem: Boolean(fotografia && String(fotografia.data || '').startsWith('blob:'))
      };
    })()`);

    confirmar(visto.obra, `${cargo}: a obra deveria ter chegado`);
    igual(visto.setores, [{ id: 'set-1', situacao: 'executed' }],
      `${cargo}: a demarcação deveria aparecer com a situação certa`);
    igual(visto.relatorioDoPavimento, 'pav-1',
      `${cargo}: o relatório fotográfico deveria estar no pavimento certo`);
    igual(visto.fotoId, 'foto-1', `${cargo}: a fotografia deveria aparecer`);
    confirmar(visto.fotoTemImagem,
      `${cargo}: o binário da fotografia deveria estar no aparelho, e não só o registro`);

    aparelho.fechar();
  }

  admin.fechar();
});

/* --------------------------------------------------------- exclusões */

/* ------------------------------------------------------- permissões */

/* `obras.criado_por` referencia `usuarios(id)`, então sessão de teste precisa de
   usuário correspondente no banco — senão o lote inteiro cai com FOREIGN KEY. */
function semearUsuarios(db) {
  const cargos = { u0: 'administrador', u1: 'tecnico', u2: 'encarregado', u3: 'cliente' };
  for (const [id, cargo] of Object.entries(cargos)) {
    db.prepare(
      `insert into usuarios (id, usuario, nome, nivel_acesso, senha_hash, senha_salt)
       values (?, ?, ?, ?, 'x', 'y')`
    ).run(id, id, id, cargo);
  }
}

function obraDeTeste(extra = {}) {
  return {
    id: 'obra-1', nome: 'MEDICAL CENTER', cidade: 'São Paulo',
    pavimentos: [{
      id: 'pav-1', nome: 'Térreo', areaTotal: 77,
      setores: [{ id: 'set-1', nome: 'Setor A', situacao: 'pending', pontos: [], area: 10 }]
    }],
    ...extra
  };
}

teste('técnico não cria nem altera estrutura pelo /sync/subir', async () => {
  /* `podeEscrever` só barrava o cliente. O técnico, que no painel apenas muda
     situação de setor, registra fotografia e lança presença, podia criar obra,
     renomear pavimento e remodelar setor chamando a rota direto. */
  const { env, db } = servidorDeTeste();
  semearUsuarios(db);
  const tecnico = { id: 'u1', nivelAcesso: 'tecnico' };

  await sync.subir(env, tecnico, { obras: [obraDeTeste()] });

  igual(db.prepare('select count(*) as t from obras').get().t, 0,
    'o técnico NÃO pode criar obra');
  igual(db.prepare('select count(*) as t from pavimentos').get().t, 0,
    'nem pavimento');
  igual(db.prepare('select count(*) as t from setores').get().t, 0,
    'nem setor');
});

teste('técnico muda a situação do setor, que é o que o cargo permite', async () => {
  /* Recusar o pedido inteiro tiraria dele o que PODE fazer: o pacote traz o
     estado todo, inclusive obra e pavimento que ele não pode gravar. O que se
     faz é ignorar o que não é dele e aplicar o que é. */
  const { env, db } = servidorDeTeste();
  semearUsuarios(db);
  const adm = { id: 'u0', nivelAcesso: 'administrador' };
  await sync.subir(env, adm, { obras: [obraDeTeste()] });
  igual(db.prepare("select situacao from setores where id='set-1'").get().situacao, 'pending',
    'pré-condição: o setor existe com a situação inicial');

  const tecnico = { id: 'u1', nivelAcesso: 'tecnico' };
  await sync.subir(env, tecnico, {
    obras: [obraDeTeste({
      nome: 'NOME TROCADO PELO TECNICO',
      pavimentos: [{
        id: 'pav-1', nome: 'RENOMEADO', areaTotal: 999,
        setores: [{ id: 'set-1', nome: 'RENOMEADO', situacao: 'executed', pontos: [], area: 999 }]
      }]
    })]
  });

  igual(db.prepare("select situacao from setores where id='set-1'").get().situacao, 'executed',
    'a situação tem de ter sido aplicada');
  igual(db.prepare("select nome from setores where id='set-1'").get().nome, 'Setor A',
    'mas o nome do setor não');
  igual(db.prepare("select nome from pavimentos where id='pav-1'").get().nome, 'Térreo',
    'nem o nome do pavimento');
  igual(db.prepare("select nome from obras where id='obra-1'").get().nome, 'MEDICAL CENTER',
    'nem o nome da obra');
});

teste('encarregado edita obra existente mas não cria obra nova', async () => {
  /* O painel esconde "+ Nova obra" do encarregado (`works.create`) e deixa ele
     editar (`works.edit`). O servidor aceitava os dois. */
  const { env, db } = servidorDeTeste();
  semearUsuarios(db);
  const encarregado = { id: 'u2', nivelAcesso: 'encarregado' };

  await sync.subir(env, encarregado, { obras: [obraDeTeste()] });
  igual(db.prepare('select count(*) as t from obras').get().t, 0,
    'encarregado não pode criar obra');

  /* Com a obra já existente, ele edita. */
  const adm = { id: 'u0', nivelAcesso: 'administrador' };
  await sync.subir(env, adm, { obras: [obraDeTeste()] });
  await sync.subir(env, encarregado, { obras: [obraDeTeste({ cidade: 'Campinas' })] });

  igual(db.prepare("select cidade from obras where id='obra-1'").get().cidade, 'Campinas',
    'mas pode editar a que já existe');
  igual(db.prepare('select count(*) as t from pavimentos').get().t, 1,
    'e continua podendo gravar pavimento');
});

teste('cliente não grava nada', async () => {
  const { env, db } = servidorDeTeste();
  semearUsuarios(db);
  const recusado = await sync.subir(env, { id: 'u3', nivelAcesso: 'cliente' }, { obras: [obraDeTeste()] });
  igual(recusado.status, 403, 'o cliente deveria receber 403');
  igual(db.prepare('select count(*) as t from obras').get().t, 0, 'e nada pode ter sido gravado');
});

teste('aparelho com estado antigo não ressuscita registro excluído', async () => {
  /* A CAUSA RAIZ de "os pavimentos estão ressurgindo".

     `paraServidor` nunca envia `excluidoEm`, e o upsert gravava o valor do
     cliente por cima: `excluido_em = excluded.excluido_em`, ou seja, null. Então
     qualquer aparelho que ainda tivesse o registro no estado o trazia de volta
     ao empurrar — o administrador apagava, o celular do colega sincronizava com
     o estado antigo, e o pavimento voltava para todo mundo.

     A guarda de carimbo não protegia: o painel carimba todo registro com a hora
     da SINCRONIZAÇÃO, não com a hora em que o dado mudou, então o aparelho mais
     desatualizado sempre tem o carimbo mais novo.

     Agora o upsert usa `coalesce(tabela.excluido_em, excluded.excluido_em)`:
     uma vez marcada, a exclusão fica. */
  const { env, db } = servidorDeTeste();
  const adm = { id: 'u1', nivelAcesso: 'administrador' };

  db.prepare('insert into obras (id, nome) values (?, ?)').run('obra-1', 'MEDICAL CENTER');
  db.prepare('insert into pavimentos (id, obra_id, nome) values (?, ?, ?)').run('pav-1', 'obra-1', 'Térreo');
  db.prepare('insert into setores (id, pavimento_id, nome) values (?, ?, ?)').run('set-1', 'pav-1', 'Setor A');

  await sync.subir(env, adm, {
    obras: [],
    exclusoes: [{ tipo: 'pavimento', id: 'pav-1' }, { tipo: 'setor', id: 'set-1' }]
  });
  igual(db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 0,
    'pré-condição: o pavimento saiu');

  /* O aparelho desatualizado empurra o estado antigo, com o pavimento e o setor
     ainda presentes e sem nenhuma marca de exclusão. */
  await sync.subir(env, adm, {
    obras: [{
      id: 'obra-1', nome: 'MEDICAL CENTER',
      pavimentos: [{
        id: 'pav-1', nome: 'Térreo', areaTotal: 77,
        setores: [{ id: 'set-1', nome: 'Setor A', situacao: 'executed', pontos: [], area: 10 }]
      }]
    }]
  });

  igual(
    db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 0,
    'o pavimento NÃO pode ter ressuscitado'
  );
  igual(
    db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 0,
    'nem o setor'
  );
});

teste('pavimento excluído some do servidor e não volta', async () => {
  /* O `/sync/subir` insere e atualiza o que recebe, e nunca apaga o que ficou
     de fora — não pode mesmo, porque o pacote é parcial e ausência significa
     "não mudou". Sem registrar a exclusão como fato, excluir pavimento valia só
     no aparelho e o registro voltava na descida seguinte. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);
  igual(db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 1,
    'pré-condição: o pavimento está no servidor');

  ctx.window.confirm = () => true;
  await ctx.eval('deleteProjectFloor("obra-1", 0)');
  /* `saveState()` agenda a sincronização para 4 s depois; o teste não espera
     esse tempo, chama direto. */
  await ctx.eval('sincronizarComServidor()');
  await pausa(700);

  igual(
    db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 0,
    'o pavimento tem de sair do servidor'
  );
  igual(
    await ctx.eval('window.NBZApi.exclusoesPendentes().length'), 0,
    'e a pendência tem de ser esquecida depois de confirmada'
  );

  /* E não volta: a descida seguinte traz a linha com excluidoEm, que a tradução
     descarta. */
  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(600);
  igual(
    await ctx.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 0,
    'e não pode reaparecer no painel'
  );
  ctx.fechar();
});

teste('exclusão feita sem sinal sobe quando a conexão volta', async () => {
  /* A pendência fica guardada até o servidor confirmar, então exclusão feita em
     obra sem sinal não se perde — mesma garantia da fotografia. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);

  /* Registra a exclusão sem sincronizar, como se estivesse offline. */
  await ctx.eval('window.NBZApi.registrarExclusao("setor", "set-1")');
  igual(await ctx.eval('window.NBZApi.exclusoesPendentes().length'), 1, 'ficou pendente');
  igual(db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 1,
    'e o servidor ainda não sabe');

  await ctx.eval('sincronizarComServidor()');
  await pausa(600);

  igual(
    db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 0,
    'ao sincronizar, a exclusão sobe'
  );
  igual(await ctx.eval('window.NBZApi.exclusoesPendentes().length'), 0, 'e deixa de ser pendente');
  ctx.fechar();
});

teste('cargo sem permissão não exclui, e a pendência não some', async () => {
  /* Recusa por cargo não pode limpar a pendência: ela sumiria como se a
     exclusão tivesse acontecido, e ninguém ficaria sabendo. O encarregado pode
     apagar setor (`regions.edit`) e não pavimento (`works.delete`). */
  const { env, db } = servidorDeTeste();
  db.prepare('insert into obras (id, nome) values (?, ?)').run('obra-1', 'MEDICAL CENTER');
  db.prepare('insert into pavimentos (id, obra_id, nome) values (?, ?, ?)').run('pav-1', 'obra-1', 'Térreo');
  db.prepare('insert into setores (id, pavimento_id, nome) values (?, ?, ?)').run('set-1', 'pav-1', 'Setor A');

  const encarregado = { id: 'u1', nivelAcesso: 'encarregado' };
  const resposta = await sync.subir(env, encarregado, {
    obras: [],
    exclusoes: [{ tipo: 'pavimento', id: 'pav-1' }, { tipo: 'setor', id: 'set-1' }]
  });

  igual(
    resposta.exclusoesAplicadas.map((i) => i.tipo), ['setor'],
    'só o setor deveria ter sido aplicado'
  );
  igual(db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 1,
    'o pavimento continua: encarregado não tem works.delete');
  igual(db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 0,
    'o setor saiu: encarregado tem regions.edit');

  /* Técnico não apaga nem setor. */
  db.prepare("update setores set excluido_em = null where id = 'set-1'").run();
  const doTecnico = await sync.subir(env, { id: 'u2', nivelAcesso: 'tecnico' }, {
    obras: [], exclusoes: [{ tipo: 'setor', id: 'set-1' }]
  });
  igual(doTecnico.exclusoesAplicadas, [], 'técnico não deveria apagar setor');
  igual(db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 1,
    'e o setor continua lá');
});

teste('pavimento replicado não herda a planta do original', async () => {
  /* A cópia levava `planImage`, medidas, nome do arquivo e `temPlanta` do
     original — afirmando ter planta que não tem. O endereço apontava para o
     binário do original (que some ao recarregar, porque o armazenamento é por
     id de pavimento) e o servidor nunca teve planta para o id novo: o painel
     pedia `/plantas/<id da cópia>` a cada sincronização e recebia 404. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);

  await ctx.eval('replicateFloor("obra-1", 0)');
  await pausa(400);

  const copia = await ctx.eval(`(() => {
    const c = projects[0].floorPlans[1];
    return { nome: c.name, planImage: c.planImage, largura: c.planWidth, arquivo: c.planFileName, temPlanta: Boolean(c.temPlanta), setores: c.regions.length };
  })()`);

  confirmar(/cópia/.test(copia.nome), `a cópia deveria existir, e veio "${copia.nome}"`);
  igual(copia.planImage, '', 'a cópia não pode herdar o endereço da imagem');
  igual(copia.largura, 0, 'nem as medidas da planta');
  igual(copia.arquivo, '', 'nem o nome do arquivo');
  igual(copia.temPlanta, false, 'nem a afirmação de que existe planta no servidor');
  igual(copia.setores, 0, 'e as demarcações continuam saindo, como já saíam');

  /* O original não pode ter sido afetado. */
  confirmar(
    String(await ctx.eval('projects[0].floorPlans[0].planImage')).startsWith('blob:'),
    'o pavimento de origem mantém a planta dele'
  );
  ctx.fechar();
});

teste('relatório fotográfico não migra de pavimento depois da fusão', () => {
  /* Bug que corrompe laudo. O painel acha o relatório pela POSIÇÃO do pavimento
     no array, e `paraPainel` calcula essa posição no array do PACOTE. A fusão
     monta outro array, unindo local e recebido, e numa descida parcial as
     posições não coincidem: o relatório passa a pertencer ao pavimento errado.

     Aqui o aparelho tem dois pavimentos e o pacote traz só o segundo. */
  const local = [{
    id: 'obra-1',
    floorPlans: [
      { id: 'pav-A', name: 'Térreo', regions: [] },
      { id: 'pav-B', name: 'Térreo2', regions: [] }
    ],
    photoReports: []
  }];
  const doServidor = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-B', name: 'Térreo2', regions: [] }],
    /* Índice 0 porque no pacote o pav-B é o único — é assim que `paraPainel`
       calcula, e é exatamente o que se precisa corrigir. */
    photoReports: [{ id: 'rel-1', floorId: 'pav-B', floorIndex: 0, photos: [] }]
  }];

  const [obra] = NBZSync.fundir(local, doServidor);

  igual(obra.floorPlans.map((p) => p.id), ['pav-A', 'pav-B'], 'os dois pavimentos permanecem');
  igual(obra.photoReports[0].floorId, 'pav-B', 'o relatório é do pav-B');
  igual(
    obra.photoReports[0].floorIndex, 1,
    'e o índice tem de apontar para a posição do pav-B no array final, não para a do pacote'
  );
});

teste('relatório de pavimento excluído sai junto', () => {
  /* Depois da fusão o array tem a união de tudo que existe, então pavimento
     ausente é pavimento excluído — e relatório pendurado nele ficaria órfão,
     apontando para índice inexistente. */
  const local = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-A', name: 'Térreo', regions: [] }],
    photoReports: [{ id: 'rel-1', floorId: 'pav-A', floorIndex: 0, photos: [] }]
  }];
  const doServidor = [{ id: 'obra-1', floorPlans: [], photoReports: [] }];

  const [obra] = NBZSync.fundir(local, doServidor, {
    exclusoes: { pavimentos: new Set(['pav-A']), obras: new Set(), setores: new Set(), relatorios: new Set(), fotos: new Set() }
  });

  igual(obra.floorPlans.length, 0, 'o pavimento saiu');
  igual(obra.photoReports.length, 0, 'e o relatório dele também');
});

teste('pavimento apagado pelo ADM some no aparelho do colega', async () => {
  /* O print do usuário: pavimentos "ressurgindo" depois de excluídos.

     `paraPainel` descarta as linhas com excluidoEm ao montar os projetos — e
     precisa descartar, senão o apagado voltaria para a tela. Mas depois disso a
     exclusão fica indistinguível de "não veio neste delta", e a fusão preserva o
     que não veio. Exclusão nenhuma chegava ao painel do colega. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(400);

  const colega = await boot({ api });
  await pausa(600);
  await preencherLogin(colega, { usuario: 'richard', senha: 'senhaforte1' });
  await pausa(1500);
  igual(
    colega.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 1,
    'pré-condição: o colega vê o pavimento'
  );

  admin.window.confirm = () => true;
  await admin.eval('deleteProjectFloor("obra-1", 0)');
  await admin.eval('sincronizarComServidor()');
  await pausa(700);
  igual(db.prepare('select count(*) as t from pavimentos where excluido_em is null').get().t, 0,
    'pré-condição: saiu do servidor');
  admin.fechar();

  /* O colega apenas sincroniza. É aqui que a exclusão tem de chegar. */
  await colega.eval('sincronizarComServidor({ apenasBaixar: true })');
  await pausa(700);

  igual(
    await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans.length'), 0,
    'o pavimento apagado pelo ADM tem de sumir no aparelho do colega'
  );
  colega.fechar();
});

teste('setor apagado pelo ADM some no aparelho do colega', async () => {
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(400);

  const colega = await boot({ api });
  await pausa(600);
  await preencherLogin(colega, { usuario: 'richard', senha: 'senhaforte1' });
  await pausa(1500);
  igual(
    colega.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].regions.length'), 1,
    'pré-condição: o colega vê o setor'
  );

  await admin.eval('window.NBZApi.registrarExclusao("setor", "set-1")');
  await admin.eval('sincronizarComServidor()');
  await pausa(700);
  igual(db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 0,
    'pré-condição: saiu do servidor');
  admin.fechar();

  await colega.eval('sincronizarComServidor({ apenasBaixar: true })');
  await pausa(700);

  igual(
    await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].regions.length'), 0,
    'o setor apagado tem de sumir no aparelho do colega'
  );
  colega.fechar();
});

/* ------------------------------------------------------ fusão delta */

/* O defeito que apagou tudo em produção, isolado na função pura.

   `/sync/baixar` entrega só o que mudou. Se alguém mexe na obra e não nos
   pavimentos, o pacote traz a obra sozinha, e `paraPainel` monta o projeto com
   `floorPlans: []` porque só conhece o que veio. A fusão antiga substituía o
   projeto local por essa versão e levava junto pavimentos, setores e
   relatórios — o aparelho mostrava "Nenhum pavimento cadastrado" com três
   pavimentos vivos no servidor.

   Ausência num delta é "não mudou". Exclusão é `excluidoEm`, e `paraPainel` já
   descarta essas linhas antes de chegar aqui. */
teste('fusão delta não apaga pavimento que o pacote não trouxe', () => {
  const local = [{
    id: 'obra-1', name: 'MEDICAL CENTER',
    floorPlans: [
      { id: 'pav-1', name: 'Térreo', planImage: 'blob:local/planta', regions: [{ id: 'set-1', name: 'Setor A' }] },
      { id: 'pav-2', name: '2º pavimento', planImage: '', regions: [] }
    ],
    photoReports: [{ id: 'rel-1', photos: [{ id: 'foto-1', data: 'blob:local/foto' }] }]
  }];

  /* O que `paraPainel` produz quando só a obra mudou. */
  const doServidor = [{
    id: 'obra-1', name: 'MEDICAL CENTER RENOMEADO',
    floorPlans: [], photoReports: []
  }];

  const [obra] = NBZSync.fundir(local, doServidor);

  igual(obra.name, 'MEDICAL CENTER RENOMEADO', 'o campo que mudou tem de vir do servidor');
  igual(obra.floorPlans.length, 2, 'os pavimentos NÃO podem ter sido apagados');
  igual(obra.floorPlans[0].regions.length, 1, 'nem os setores dentro deles');
  igual(obra.floorPlans[0].planImage, 'blob:local/planta', 'nem a planta local');
  igual(obra.photoReports.length, 1, 'nem os relatórios');
  igual(obra.photoReports[0].photos[0].data, 'blob:local/foto', 'nem o binário da foto');
});

teste('fusão delta não apaga setor que o pacote não trouxe', () => {
  /* Um nível abaixo, e o mesmo erro: pacote com o pavimento e sem os setores. */
  const local = [{
    id: 'obra-1', floorPlans: [{ id: 'pav-1', name: 'Térreo', planImage: 'blob:x', regions: [
      { id: 'set-1', name: 'Setor A', status: 'executed' },
      { id: 'set-2', name: 'Setor B', status: 'pending' }
    ] }], photoReports: []
  }];
  const doServidor = [{
    id: 'obra-1', floorPlans: [{ id: 'pav-1', name: 'TÉRREO REVISADO', planImage: '', regions: [] }], photoReports: []
  }];

  const [obra] = NBZSync.fundir(local, doServidor);

  igual(obra.floorPlans[0].name, 'TÉRREO REVISADO', 'o nome novo vem do servidor');
  igual(obra.floorPlans[0].regions.map((r) => r.id).sort(), ['set-1', 'set-2'], 'os setores permanecem');
  igual(obra.floorPlans[0].planImage, 'blob:x', 'e a planta local também');
});

teste('planta apagada no servidor some também nos outros aparelhos', () => {
  /* A preservação da planta local, se for incondicional, impede a exclusão de
     propagar: quem apaga num aparelho a vê voltar nos outros. O servidor nunca
     manda binário, então "planImage vazio" não distingue nada por si só — o
     DELETE também limpa o nome do arquivo, e é esse o sinal. */
  const local = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-1', planImage: 'blob:local/planta', planFileName: 'planta.jpg', temPlanta: true, regions: [] }],
    photoReports: []
  }];
  const doServidor = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-1', planImage: '', planFileName: '', temPlanta: false, regions: [] }],
    photoReports: []
  }];

  /* Fila vazia: este aparelho não pretende enviar planta nenhuma, logo a cópia
     local é resto de algo que já foi apagado. */
  const [obra] = NBZSync.fundir(local, doServidor, { plantaPendente: () => false });
  igual(obra.floorPlans[0].planImage, '', 'a planta apagada no servidor tem de sumir daqui também');
});

teste('planta importada e ainda não enviada sobrevive à sincronização', () => {
  /* O contrário, e o erro que seria pior: apagar a planta de quem acabou de
     importá-la, antes de ela conseguir subir. Aqui `temPlanta` também é falso,
     mas o nome do arquivo já subiu pelo /sync/subir — e é o que diferencia. */
  const local = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-1', planImage: 'blob:local/recem-importada', planFileName: 'planta.jpg', temPlanta: false, regions: [] }],
    photoReports: []
  }];
  const doServidor = [{
    id: 'obra-1',
    floorPlans: [{ id: 'pav-1', planImage: '', planFileName: '', temPlanta: false, regions: [] }],
    photoReports: []
  }];

  /* Na fila: o aparelho pretende enviar, então a cópia local é o original. */
  const [obra] = NBZSync.fundir(local, doServidor, { plantaPendente: () => true });
  igual(obra.floorPlans[0].planImage, 'blob:local/recem-importada',
    'planta esperando envio não pode ser apagada pela sincronização');
});

teste('fusão delta aplica o que o servidor de fato mandou', () => {
  /* Contraprova: preservar não pode virar ignorar. O que vem no pacote tem de
     substituir o local, senão alteração feita noutro aparelho nunca chegaria. */
  const local = [{
    id: 'obra-1', floorPlans: [{ id: 'pav-1', regions: [{ id: 'set-1', status: 'pending' }] }], photoReports: []
  }];
  const doServidor = [{
    id: 'obra-1', floorPlans: [
      { id: 'pav-1', regions: [{ id: 'set-1', status: 'executed' }] },
      { id: 'pav-2', regions: [] }
    ], photoReports: []
  }];

  const [obra] = NBZSync.fundir(local, doServidor);

  igual(obra.floorPlans.length, 2, 'o pavimento novo do servidor tem de aparecer');
  igual(obra.floorPlans[0].regions[0].status, 'executed', 'e a situação nova tem de vencer a local');
});

/* --------------------------------------------------- busca periódica */

teste('quem só consulta recebe a demarcação feita noutro aparelho', async () => {
  /* A pergunta que isto responde: "demarquei uma área aqui, aparece no celular
     dele?". Antes aparecia só se ele recarregasse ou entrasse de novo — a
     sincronização era disparada por gravação local e por login, e nunca por
     passar o tempo. Quem abriu o painel de manhã via a obra de manhã. */
  const { api } = servidorDeTeste();

  const engenheiro = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(engenheiro, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(engenheiro);
  await engenheiro.eval('sincronizarComServidor()');
  await pausa(400);

  /* O fiscal entra e vê o que existe até agora: um setor. */
  const fiscal = await boot({ api });
  await pausa(600);
  await preencherLogin(fiscal, { usuario: 'richard', senha: 'senhaforte1' });
  await pausa(1500);
  igual(
    fiscal.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].regions.length'), 1,
    'pré-condição: o fiscal começa com o setor que já existia'
  );

  /* O engenheiro demarca outra área e grava. */
  await engenheiro.eval(`(() => {
    projects[0].floorPlans[0].regions.push({
      id: 'set-2', name: 'Setor B', status: 'inProgress',
      points: [{x:40,y:40},{x:60,y:40},{x:60,y:60},{x:40,y:60}], area: 80
    });
    saveState();
  })()`);
  await engenheiro.eval('sincronizarComServidor()');
  await pausa(400);
  engenheiro.fechar();

  /* O fiscal NÃO toca em nada — é esse o ponto. Só o tempo passa, e é a busca
     periódica que tem de trazer a novidade. */
  await fiscal.eval('sincronizarComServidor({ apenasBaixar: true })');
  await pausa(600);

  const setores = await fiscal.eval(
    'projects.find((p) => p.id === "obra-1").floorPlans[0].regions.map((r) => r.id).sort()'
  );
  igual(setores, ['set-1', 'set-2'], 'a demarcação nova deveria ter chegado sozinha');
  fiscal.fechar();
});

teste('a busca periódica não reescreve o servidor, para não estourar a cota', async () => {
  /* O passo de subida manda o estado INTEIRO, não só o que mudou. Se a busca
     periódica empurrasse, trinta pessoas consultando de minuto em minuto
     passariam de dois milhões de gravações por dia contra as cem mil do plano
     gratuito — e o banco pararia de aceitar escrita no meio do expediente. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);

  const antes = db.prepare('select atualizado_em from obras where id = ?').get('obra-1').atualizado_em;

  /* Muitas buscas seguidas, sem nenhuma alteração local. */
  for (let i = 0; i < 3; i += 1) {
    await ctx.eval('sincronizarComServidor({ apenasBaixar: true })');
    await pausa(200);
  }

  const depois = db.prepare('select atualizado_em from obras where id = ?').get('obra-1').atualizado_em;
  igual(depois, antes, 'buscar não pode ter reescrito a obra no servidor');
  ctx.fechar();
});

/* ----------------------------------------------------- armazenamento */

teste('a barra de armazenamento mostra o uso real das fotografias', async () => {
  /* O teto de 9,5 GB recusa upload quando chega. Sem esta barra, a pessoa só
     descobriria o limite na obra, com a visita registrada e a foto recusada. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);

  await ctx.eval('atualizarUsoDoArmazenamento()');
  await pausa(400);

  const cartao = await ctx.eval(`(() => {
    const el = document.querySelector('#storageCard');
    return {
      oculto: el.hidden,
      porcentagem: document.querySelector('#storagePercent').textContent,
      nota: document.querySelector('#storageNote').textContent,
      faixa: document.querySelector('#storageFill').dataset.faixa,
      largura: document.querySelector('#storageFill').style.width
    };
  })()`);

  confirmar(!cartao.oculto, 'o cartão deveria aparecer para quem registra fotografia');
  confirmar(/de 9,50 GB/.test(cartao.nota), `a nota deveria citar o teto, e é "${cartao.nota}"`);
  confirmar(/1 fotografia\b/.test(cartao.nota), `deveria contar a fotografia, e diz "${cartao.nota}"`);
  confirmar(/4 semanas/.test(cartao.nota), `deveria explicar a retenção, e diz "${cartao.nota}"`);
  igual(cartao.faixa, 'ok', 'com uma foto o uso é mínimo, então a faixa é a verde');

  /* Com arquivo guardado a barra não pode ficar vazia nem o rótulo dizer "0%":
     uma foto de 250 KB em 9,5 GB arredonda para zero, e mostrar zero com
     arquivo no bucket diz exatamente o contrário do que aconteceu. */
  confirmar(parseFloat(cartao.largura) > 0, `a barra deveria ter largura visível, e tem "${cartao.largura}"`);
  confirmar(cartao.porcentagem !== '0%',
    `o rótulo não deveria dizer 0% havendo foto guardada, e diz "${cartao.porcentagem}"`);
  ctx.fechar();
});

teste('a barra some para o cargo que não registra fotografia', async () => {
  /* Cota de armazenamento é informação de quem sofre a consequência. Para o
     cliente, que só consulta, seria ruído. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await ctx.eval('atualizarUsoDoArmazenamento()');
  await pausa(300);
  confirmar(!ctx.eval('document.querySelector("#storageCard").hidden'),
    'pré-condição: para o administrador o cartão aparece');

  /* Troca o cargo da sessão para 'cliente' e manda renderizar de novo. */
  await ctx.eval('(async () => { currentUser.role = "cliente"; await atualizarUsoDoArmazenamento(); })()');
  await pausa(300);

  confirmar(ctx.eval('document.querySelector("#storageCard").hidden'),
    'para o cliente o cartão deveria sumir');
  ctx.fechar();
});

/* ---------------------------------------------------------- usuarios */

/* Preenche o formulário de novo usuário como o administrador faz na tela.
   `renderUsersList()` antes porque é ele quem popula as opções de cargo — sem
   isso o <select> está vazio e o cargo iria em branco. */
async function cadastrarPeloPainel(ctx, { nome, usuario, senha, cargo = 'engenheiro' }) {
  await ctx.eval('renderUsersList()');
  ctx.doc.querySelector('#newUserName').value = nome;
  ctx.doc.querySelector('#newUserLogin').value = usuario;
  ctx.doc.querySelector('#newUserRole').value = cargo;
  ctx.doc.querySelector('#newUserPassword').value = senha;
  ctx.submit('#newUserForm');
  await pausa(1600);
  return ctx.doc.querySelector('#newUserFeedback').textContent;
}

teste('o usuário cadastrado pelo administrador entra de outro aparelho', async () => {
  /* O teste que responde à pergunta toda. Antes, o cadastro ia só para o
     localStorage do navegador do administrador, e a pessoa batia em "usuário ou
     senha inválidos" — mensagem correta para o servidor, enganosa para quem
     acabara de cadastrar. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  const aviso = await cadastrarPeloPainel(admin, {
    nome: 'Caio Mendonça', usuario: 'caiomdc', senha: 'provisoria123', cargo: 'engenheiro'
  });

  /* Chegou ao banco do servidor, não só à tela. */
  const criado = db.prepare(
    'select usuario, nome, nivel_acesso, precisa_trocar_senha, ativo from usuarios where usuario = ?'
  ).get('caiomdc');
  confirmar(criado, `o usuário deveria existir no D1; a tela disse "${aviso}"`);
  igual(criado.nome, 'Caio Mendonça', 'com o nome digitado');
  igual(criado.nivel_acesso, 'engenheiro', 'e o cargo escolhido');
  igual(criado.precisa_trocar_senha, 1, 'com senha provisória a trocar no primeiro acesso');
  igual(criado.ativo, 1, 'e ativo');
  admin.fechar();

  /* Aparelho limpo, que nunca viu esse cadastro: localStorage e IndexedDB
     vazios, só o mesmo servidor em comum. */
  const dele = await boot({ api });
  await pausa(600);
  await preencherLogin(dele, { usuario: 'caiomdc', senha: 'provisoria123' });
  confirmar(painelAberto(dele), 'o painel deveria ter aberto para quem foi cadastrado');
  dele.fechar();
});

teste('a lista de usuários vem do servidor, não do navegador', async () => {
  /* O administrador precisa enxergar quem já existe, mesmo num aparelho que
     nunca cadastrou ninguém. Sem isso ele recadastraria gente, e só descobriria
     pelo erro de usuário duplicado.

     Quem abre a lista aqui é o `richard`, e não o recém-cadastrado: usuário com
     senha provisória recebe 428 em TODAS as rotas até definir a própria senha —
     regra do servidor, e é ela que garante que o administrador deixe de
     conhecer a senha de quem usa o sistema. */
  const { api } = servidorDeTeste();

  const primeiro = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeiro, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await cadastrarPeloPainel(primeiro, {
    nome: 'Caio Mendonça', usuario: 'caiomdc', senha: 'provisoria123', cargo: 'engenheiro'
  });
  primeiro.fechar();

  /* Aparelho limpo: este navegador nunca viu cadastro nenhum. */
  const segundo = await boot({ api });
  await pausa(600);
  igual(segundo.eval('users.length'), 0, 'o aparelho novo começa sem usuário local');
  await preencherLogin(segundo, { usuario: 'richard', senha: 'senhaforte1' });
  confirmar(painelAberto(segundo), 'deveria ter entrado');

  const carregou = await segundo.eval('carregarUsuariosDoServidor()');
  confirmar(carregou, 'a lista deveria ter vindo do servidor');
  const nomes = await segundo.eval('users.map((u) => u.username).sort()');
  igual(nomes, ['caiomdc', 'richard'], 'o aparelho novo deveria ver os dois usuários');
  segundo.fechar();
});

teste('usuário com senha provisória é barrado até definir a própria senha', async () => {
  /* Documenta a regra que derrubou a versão anterior deste teste, e que importa
     na operação: a pessoa entra, mas o servidor recusa o resto com 428 até ela
     trocar a senha. É o que faz o registro de obra valer como prova de autoria —
     enquanto o administrador souber a senha, não vale. */
  const { api } = servidorDeTeste();
  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await cadastrarPeloPainel(admin, {
    nome: 'Caio Mendonça', usuario: 'caiomdc', senha: 'provisoria123'
  });
  admin.fechar();

  const dele = await boot({ api });
  await pausa(600);
  await preencherLogin(dele, { usuario: 'caiomdc', senha: 'provisoria123' });
  confirmar(painelAberto(dele), 'o painel abre — o login em si é válido');
  confirmar(dele.eval('currentUser.precisaTrocarSenha'),
    'e o painel sabe que a senha é provisória, para avisar em vez de deixar bater numa parede');

  const recusado = await dele.eval(`(async () => {
    try { await window.NBZApi.listarUsuarios(); return 0; }
    catch (erro) { return erro.status; }
  })()`);
  igual(recusado, 428, 'o servidor deveria recusar com 428 até a troca de senha');
  dele.fechar();
});

teste('excluir o usuário derruba o acesso dele de verdade', async () => {
  /* Excluir só no navegador seria pior que não ter o botão: a tela mostraria a
     pessoa como removida e ela continuaria entrando de qualquer aparelho. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await cadastrarPeloPainel(admin, {
    nome: 'Caio Mendonça', usuario: 'caiomdc', senha: 'provisoria123'
  });
  const id = db.prepare('select id from usuarios where usuario = ?').get('caiomdc').id;

  await admin.eval(`(async () => { await window.NBZApi.excluirUsuario('${id}'); })()`);
  await pausa(400);
  admin.fechar();

  const dele = await boot({ api });
  await pausa(600);
  await preencherLogin(dele, { usuario: 'caiomdc', senha: 'provisoria123' });
  confirmar(!painelAberto(dele), 'o excluído NÃO deveria conseguir entrar');
  dele.fechar();
});

/* ----------------------------------------------------------- plantas */

/* Reproduz o que o painel faz ao importar uma planta, sem passar pela tela: o
   `rasterizePlanFile` depende de canvas, que o jsdom não implementa. O que
   importa testar está depois disso — guardar o binário, enfileirar e subir. */
async function importarPlanta(ctx, pavimentoId = 'pav-1') {
  return ctx.eval(`(async () => {
    const blob = window.NBZMidia.dataUriParaBlob(${JSON.stringify(JPEG_1X1)});
    await window.NBZMidia.guardarPlanta('${pavimentoId}', blob);
    const url = await window.NBZMidia.urlDaPlanta('${pavimentoId}');
    const floor = projects[0].floorPlans[0];
    floor.planImage = url;
    floor.planWidth = 1200;
    floor.planHeight = 800;
    floor.planFileName = 'planta-terreo.pdf';
    window.NBZApi.enfileirarPlanta('${pavimentoId}', {
      largura: 1200, altura: 800, arquivo: 'planta-terreo.pdf'
    });
    saveState();
    return url;
  })()`);
}

teste('a planta importada num aparelho sobe para o servidor', async () => {
  const { api, db, env } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);

  await ctx.eval('sincronizarComServidor()');

  const pavimento = db.prepare(
    'select planta_r2_key, planta_largura, planta_altura, planta_arquivo from pavimentos where id = ?'
  ).get('pav-1');
  confirmar(pavimento.planta_r2_key, 'a planta deveria ter chave no bucket');
  confirmar(/^obras\/obra-1\/plantas\/pav-1-/.test(pavimento.planta_r2_key),
    `a chave deveria ser por obra e pavimento, e é "${pavimento.planta_r2_key}"`);
  igual(pavimento.planta_largura, 1200, 'a largura deveria ter subido junto');
  igual(pavimento.planta_altura, 800, 'a altura também');
  igual(pavimento.planta_arquivo, 'planta-terreo.pdf', 'e o nome do arquivo de origem');

  /* O binário tem de estar no bucket, não só registrado no banco. */
  const objeto = await env.FOTOS.get(pavimento.planta_r2_key);
  confirmar(objeto, 'o arquivo deveria estar no R2');
  ctx.fechar();
});

teste('a varredura não reenvia planta que o colega apagou', async () => {
  /* O mecanismo de segurança se voltando contra a exclusão: a varredura
     enfileira toda planta que está no aparelho e não está no servidor, e roda
     ANTES da descida no mesmo ciclo. Então o aparelho de quem não apagou
     concluía "falta enviar" e reenviava — a planta ressuscitava, e apagar
     virava impossível.

     A lista de já enviadas é o que separa "nunca subiu" de "subiu e alguém
     apagou". É a mesma proteção que as fotografias sempre tiveram. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);
  confirmar(db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'pré-condição: a planta subiu');

  /* Outra pessoa apaga: mexe-se direto no banco para simular o aparelho dela,
     sem tocar no estado deste. */
  db.prepare(
    "update pavimentos set planta_r2_key = null, planta_arquivo = '', planta_largura = 0, atualizado_em = ? where id = ?"
  ).run(new Date().toISOString(), 'pav-1');

  /* Este aparelho sincroniza sem saber de nada: ainda tem a planta local e o
     servidor não tem mais. */
  await ctx.eval('sincronizarComServidor()');
  await pausa(600);

  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'a planta NÃO pode ter sido reenviada por este aparelho'
  );
  igual(
    await ctx.eval('projects[0].floorPlans[0].planImage'), '',
    'e a cópia local tem de ter sumido junto'
  );
  ctx.fechar();
});

teste('planta apagada pelo administrador some no aparelho que só a baixou', async () => {
  /* O caso que o usuário descreveu: o administrador apaga, e no aparelho do
     colega a planta continua lá — e volta ao servidor.

     A causa era a lista de plantas conhecidas registrar apenas o ENVIO. Quem
     baixou a planta nunca a enviou, então a varredura dele a tratava como
     inédita, reenviava, e a exclusão era desfeita por quem só lia. */
  const { api, db } = servidorDeTeste();

  const admin = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(admin, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(admin);
  await importarPlanta(admin);
  await admin.eval('sincronizarComServidor()');
  await pausa(400);

  /* O colega entra e recebe a planta. */
  const colega = await boot({ api });
  await pausa(600);
  await preencherLogin(colega, { usuario: 'richard', senha: 'senhaforte1' });
  await pausa(1500);
  confirmar(
    String(await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].planImage')).startsWith('blob:'),
    'pré-condição: o colega recebeu a planta'
  );

  /* O administrador apaga. */
  await admin.eval('(async () => { await window.NBZApi.excluirPlanta("pav-1"); })()');
  await pausa(300);
  igual(db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'pré-condição: saiu do servidor');
  admin.fechar();

  /* O colega sincroniza — e não pode nem continuar com a planta, nem repô-la. */
  await colega.eval('sincronizarComServidor()');
  await pausa(600);

  igual(
    await colega.eval('projects.find((p) => p.id === "obra-1").floorPlans[0].planImage'), '',
    'a planta tem de sumir no aparelho do colega'
  );
  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'e ele NÃO pode tê-la reenviado ao servidor'
  );
  colega.fechar();
});

teste('técnico não apaga planta nem chamando a rota direto', async () => {
  /* O painel libera planta por `regions.edit`, que o técnico não tem — ele não
     vê o botão. Mas o servidor conferia pela regra de FOTOGRAFIA, que ele tem,
     então bastava chamar a rota para apagar planta de todo mundo.

     Esconder botão não é permissão: é a primeira frase do cabeçalho do Worker,
     e a regra tinha divergido justamente onde o estrago é global. */
  const { env, db } = servidorDeTeste();
  db.prepare('insert into obras (id, nome) values (?, ?)').run('obra-1', 'MEDICAL CENTER');
  db.prepare('insert into pavimentos (id, obra_id, nome, planta_r2_key) values (?, ?, ?, ?)')
    .run('pav-1', 'obra-1', 'Térreo', 'obras/obra-1/plantas/pav-1-1.jpg');

  const recusado = await fotos.excluirPlanta(env, { id: 'u1', nivelAcesso: 'tecnico' }, 'pav-1');
  igual(recusado.status, 403, 'o técnico deveria receber 403');
  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'e a planta tem de continuar no servidor'
  );

  /* Importar também: mesma regra, mesmo motivo. */
  const envioRecusado = await fotos.enviarPlanta(
    env, { id: 'u1', nivelAcesso: 'tecnico' },
    { headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new Uint8Array(20).buffer) },
    new URLSearchParams({ pavimento: 'pav-1' })
  );
  igual(envioRecusado.status, 403, 'o técnico também não importa planta');

  /* Contraprova: encarregado tem `regions.edit` e precisa continuar podendo. */
  const permitido = await fotos.excluirPlanta(env, { id: 'u2', nivelAcesso: 'encarregado' }, 'pav-1');
  confirmar(!permitido.erro, `encarregado deveria poder remover, e veio "${permitido.erro || ''}"`);
  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'e a remoção dele tem de valer'
  );
});

teste('remover a planta preserva as áreas demarcadas', async () => {
  /* Antes as demarcações eram apagadas junto, e isso era errado duas vezes: não
     propagava (o sync nunca apaga o que fica de fora, então voltavam na descida
     seguinte) e não deveria propagar — área, m² e situação são o que alimenta o
     laudo, e a planta é só o desenho de fundo. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'Richard', usuario: 'richard', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);

  /* Duas coisas que o `removeFloorPlan()` exige e o teste precisa montar: o
     croqui aberto, porque ele lê o pavimento de `sketchProjectId`/`sketchFloorIndex`,
     e o `confirm`, que o jsdom não implementa e devolve undefined. Sem as duas,
     a função sai na primeira linha sem fazer nada. */
  await ctx.eval('sketchProjectId = "obra-1"; sketchFloorIndex = 0;');
  ctx.window.confirm = () => true;
  await ctx.eval('removeFloorPlan()');
  await pausa(900);

  igual(
    await ctx.eval('projects[0].floorPlans[0].regions.length'), 1,
    'o setor demarcado tem de continuar na tela'
  );
  igual(
    await ctx.eval('projects[0].floorPlans[0].planImage'), '',
    'e a planta tem de ter saído'
  );
  igual(
    db.prepare('select count(*) as t from setores where excluido_em is null').get().t, 1,
    'o setor continua no servidor'
  );
  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'e a planta saiu do servidor'
  );
  ctx.fechar();
});

teste('a limpeza de órfãos não apaga a planta', async () => {
  /* O defeito que deixou o pavimento com quadro de imagem quebrada no celular:
     a planta mora na mesma loja das fotografias, e a limpeza montava a lista do
     que está em uso só com ids de FOTO. Tudo o mais virava lixo — inclusive a
     planta recém-baixada.

     No arranque a ordem era cruel: `reidratarPlantas()` restaurava a planta e
     `limparMidiaOrfa()` a apagava em seguida, revogando o endereço. O estado
     seguia apontando para um arquivo que não existia mais. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);

  confirmar(
    await ctx.eval('(async () => Boolean(await window.NBZMidia.registroDaPlanta("pav-1")))()'),
    'pré-condição: a planta está no armazenamento local'
  );

  await ctx.eval('limparMidiaOrfa()');
  await pausa(300);

  confirmar(
    await ctx.eval('(async () => Boolean(await window.NBZMidia.registroDaPlanta("pav-1")))()'),
    'a limpeza NÃO pode ter apagado a planta do pavimento que existe'
  );
  /* E a foto, que sempre foi o caso previsto, continua protegida. */
  confirmar(
    await ctx.eval('(async () => Boolean(await window.NBZMidia.lerRegistro("foto-1")))()'),
    'nem a fotografia em uso'
  );
  ctx.fechar();
});

teste('a limpeza apaga a planta de pavimento que não existe mais', async () => {
  /* Contraprova: proteger não pode virar nunca apagar, senão o armazenamento do
     celular cresce para sempre com planta de obra excluída. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  await ctx.eval(`(async () => {
    const blob = window.NBZMidia.dataUriParaBlob(${JSON.stringify(JPEG_1X1)});
    await window.NBZMidia.guardarPlanta('pavimento-que-sumiu', blob);
  })()`);
  confirmar(
    await ctx.eval('(async () => Boolean(await window.NBZMidia.registroDaPlanta("pavimento-que-sumiu")))()'),
    'pré-condição: o binário órfão está lá'
  );

  await ctx.eval('limparMidiaOrfa()');
  await pausa(300);

  confirmar(
    !await ctx.eval('(async () => Boolean(await window.NBZMidia.registroDaPlanta("pavimento-que-sumiu")))()'),
    'planta sem pavimento tem de ser removida'
  );
  ctx.fechar();
});

teste('planta sem marca de origem não é reenviada nem mantida', async () => {
  /* COMPROMISSO DELIBERADO, e vale explicar porque contraria uma versão
     anterior deste mesmo teste.

     A varredura já recuperava qualquer planta local ausente do servidor. Isso
     resolvia o caso da planta importada antes de existir o envio — e causava a
     ressurreição: a varredura roda antes da descida, então o aparelho que ainda
     não soube da exclusão repunha a planta que o administrador apagara.

     Entre "recupera planta órfã sozinha" e "exclusão funciona", a segunda vale
     mais: a primeira é situação de uma vez só, a segunda é uso diário. Então a
     varredura passou a exigir marca de origem, e a planta órfã deixou de subir
     sozinha — mas o distintivo acusa, e reimportar resolve. Perda silenciosa é
     que não pode haver. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  /* Planta no estado, sem fila e sem marca de origem: o retrato de quem
     importou antes de o envio existir. */
  await ctx.eval(`(() => {
    const floor = projects[0].floorPlans[0];
    floor.planImage = ${JSON.stringify(JPEG_1X1)};
    floor.planWidth = 1800;
    floor.planHeight = 1272;
    floor.planFileName = 'N644-23-LOIM-0001-03S-HO-R00.jpg';
    floor.temPlanta = false;
    saveState();
  })()`);

  await ctx.eval('sincronizarComServidor()');
  await pausa(600);

  igual(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key, null,
    'sem marca de origem, a varredura NÃO pode reenviar'
  );

  /* E a cópia local também sai. Não há como distinguir "importei antes de o
     envio existir" de "o administrador apagou": nos dois casos há planta aqui,
     nenhuma lá e nenhuma marca de origem. Entre manter uma planta que nunca
     poderá subir e fazer a exclusão funcionar, vale a exclusão — é uso diário
     contra situação de uma vez só. Reimportar devolve a planta com marca. */
  igual(
    await ctx.eval('projects[0].floorPlans[0].planImage'), '',
    'a cópia local sem origem é tratada como apagada'
  );
  ctx.fechar();
});

teste('planta importada agora sobe, porque tem marca de origem', async () => {
  /* Contraprova: exigir origem não pode ter quebrado o caminho normal. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);

  await ctx.eval('sincronizarComServidor()');
  await pausa(600);

  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'planta importada neste aparelho tem de subir normalmente'
  );
  ctx.fechar();
});

teste('outro aparelho recebe a planta e não só os setores', async () => {
  const { api, db } = servidorDeTeste();
  const primeira = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(primeira, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(primeira);
  await importarPlanta(primeira);
  await primeira.eval('sincronizarComServidor()');
  primeira.fechar();

  /* Aparelho novo: entra e sincroniza do zero. É o caso que motivou tudo isto —
     antes, ele recebia o pavimento e os setores, e a planta ficava para trás.
     O login já dispara `sincronizarComServidor({completo: true})`; a espera dá
     tempo de a descida e o download do binário terminarem. */
  const segunda = await boot({ api });
  await pausa(600);
  await preencherLogin(segunda, { usuario: 'andre', senha: 'senhaforte1' });
  confirmar(painelAberto(segunda), 'deveria ter entrado');
  await pausa(1500);

  /* Busca pelo id: o painel nasce com obras de demonstração, então `projects[0]`
     aqui não é a obra que veio do servidor. */
  const planta = await segunda.eval(
    'projects.find((p) => p.id === "obra-1").floorPlans[0].planImage'
  );
  confirmar(String(planta).startsWith('blob:'),
    `o segundo aparelho deveria ter a planta local, e tem "${planta}"`);

  /* E o binário tem de estar no IndexedDB dele, não só uma URL solta: é o que
     faz a planta continuar abrindo dentro da obra, sem sinal. */
  const guardada = await segunda.eval(
    '(async () => Boolean(await window.NBZMidia.registroDaPlanta("pav-1")))()'
  );
  confirmar(guardada, 'a planta deveria ter sido gravada no armazenamento local');
  igual(db.prepare('select count(*) as t from setores').get().t, 1, 'e o setor continua lá');
  segunda.fechar();
});

teste('sincronizar de novo não apaga a planta que o aparelho já tem', async () => {
  /* O pacote do servidor sempre traz `planImage: ''`. Sem a preservação em
     `fundir`, cada sincronização apagaria a planta local — e o engenheiro veria
     o desenho sumir sozinho no meio da visita, com os setores flutuando. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  const original = await importarPlanta(ctx);
  await ctx.eval('sincronizarComServidor()');

  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(400);

  const depois = await ctx.eval('projects[0].floorPlans[0].planImage');
  igual(depois, original, 'a planta local deveria ter sobrevivido à sincronização');
  ctx.fechar();
});

teste('aparelho com estado velho não ressuscita a planta apagada', async () => {
  /* O que de fato aconteceu em produção: alguém apagou a planta, o DELETE
     limpou os campos no banco, e o aparelho de outra pessoa — que ainda tinha o
     nome do arquivo e as medidas na memória — empurrou tudo de volta no
     /sync/subir seguinte. A planta ressuscitava.

     A guarda `excluded.atualizado_em >= pavimentos.atualizado_em` não protegia:
     o painel carimba TODO registro com a hora da sincronização, não com a hora
     em que o dado mudou, então o aparelho desatualizado sempre tem o carimbo
     mais novo. A correção foi tirar os dados da planta do sync: quem os escreve
     são as rotas de planta, e mais ninguém. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);
  await ctx.eval('sincronizarComServidor()');
  await pausa(400);
  confirmar(db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'pré-condição: a planta subiu');

  await ctx.eval('(async () => { await window.NBZApi.excluirPlanta("pav-1"); })()');
  await pausa(300);

  /* Aparelho desatualizado empurra o estado antigo, com nome e medidas. */
  await ctx.eval(`(async () => {
    const floor = projects[0].floorPlans[0];
    floor.planFileName = 'N644-23-LOIM-0001-03S-HO-R00.jpg';
    floor.planWidth = 1800;
    floor.planHeight = 1272;
    await window.NBZApi.subirEstado(window.NBZSync.paraServidor(projects));
  })()`);
  await pausa(400);

  const pavimento = db.prepare(
    'select planta_r2_key, planta_arquivo, planta_largura from pavimentos where id = ?'
  ).get('pav-1');
  igual(pavimento.planta_r2_key, null, 'a chave tem de continuar limpa');
  igual(pavimento.planta_arquivo, '', 'o nome do arquivo NÃO pode ter voltado pelo sync');
  igual(pavimento.planta_largura, 0, 'nem as medidas');
  ctx.fechar();
});

teste('remover a planta apaga no servidor e ela não volta no sync seguinte', async () => {
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);
  await importarPlanta(ctx);
  await ctx.eval('sincronizarComServidor()');
  confirmar(
    db.prepare('select planta_r2_key from pavimentos where id = ?').get('pav-1').planta_r2_key,
    'pré-condição: a planta deveria estar no servidor'
  );

  await ctx.eval('(async () => { await window.NBZApi.excluirPlanta("pav-1"); })()');

  const pavimento = db.prepare(
    'select planta_r2_key, planta_largura, planta_arquivo from pavimentos where id = ?'
  ).get('pav-1');
  igual(pavimento.planta_r2_key, null, 'a chave deveria ter sido limpa no banco');
  igual(pavimento.planta_largura, 0, 'e as dimensões zeradas');
  igual(pavimento.planta_arquivo, '', 'e o nome do arquivo');

  /* A parte que mais importa: sem limpar no servidor, `temPlanta` seguiria
     verdadeiro e a próxima descida traria a planta de volta. */
  await ctx.eval('sincronizarComServidor({ completo: true })');
  await pausa(400);
  const voltou = await ctx.eval('projects[0].floorPlans[0].temPlanta');
  confirmar(!voltou, 'o servidor não deveria mais declarar planta para este pavimento');
  ctx.fechar();
});

/* Lê o distintivo de situação da planta como a tela o mostra. */
function situacaoDaPlanta(ctx, indice = 0) {
  return ctx.eval(`(() => {
    renderPlanSyncStatus(projects[0].floorPlans[${indice}]);
    const el = document.querySelector('#planSyncStatus');
    return { texto: el.textContent, situacao: el.dataset.situacao, oculto: el.hidden };
  })()`);
}

teste('a tela diz se a planta já foi sincronizada', async () => {
  /* A pergunta que isto responde na obra é "já posso fechar o aplicativo?".
     Antes, planta importada sem sinal era visualmente idêntica a planta já
     guardada no servidor. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  /* Sem planta nenhuma, o distintivo não aparece: rótulo permanente vira ruído. */
  const semPlanta = await situacaoDaPlanta(ctx);
  confirmar(semPlanta.oculto, 'sem planta, o distintivo deveria ficar escondido');

  await importarPlanta(ctx);
  const naFila = await situacaoDaPlanta(ctx);
  igual(naFila.situacao, 'pendente', `na fila deveria indicar pendência, e indica "${naFila.texto}"`);
  confirmar(/aguardando/.test(naFila.texto), `o texto deveria falar em espera, e é "${naFila.texto}"`);

  await ctx.eval('sincronizarComServidor()');
  await pausa(400);

  const depois = await situacaoDaPlanta(ctx);
  igual(depois.situacao, 'ok', `depois de subir deveria indicar sucesso, e indica "${depois.texto}"`);
  confirmar(/sincronizada/.test(depois.texto), `o texto deveria confirmar, e é "${depois.texto}"`);
  ctx.fechar();
});

teste('pavimento com medidas de planta e nenhum desenho acusa perda', async () => {
  /* O estado que ficou invisível em produção: o `fundir` apagava a planta do
     aparelho a cada sincronização (antes da correção), e sobravam as dimensões
     e o nome do arquivo, que viajam pelos dados do pavimento. A barra mostrava
     o nome como se houvesse planta, o croqui aparecia vazio, e nenhum
     distintivo surgia — nem "não enviada", porque não há o que enviar.

     Sem este aviso, a pessoa fica sem nada para olhar e sem saber o que fazer. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  const estado = await ctx.eval(`(() => {
    const floor = projects[0].floorPlans[0];
    floor.planImage = '';
    floor.planWidth = 1800;
    floor.planHeight = 1272;
    floor.planFileName = 'N644-23-LOIM-0001-03S-HO-R00.jpg';
    floor.temPlanta = false;
    renderPlanSyncStatus(floor);
    const el = document.querySelector('#planSyncStatus');
    return { oculto: el.hidden, texto: el.textContent, situacao: el.dataset.situacao, dica: el.title };
  })()`);

  confirmar(!estado.oculto, 'o distintivo NÃO pode ficar escondido neste estado');
  igual(estado.situacao, 'alerta', `deveria alertar, e indica "${estado.texto}"`);
  confirmar(/reimporte/i.test(estado.texto), `deveria dizer o que fazer, e diz "${estado.texto}"`);
  confirmar(/nem no servidor/.test(estado.dica), `a explicação deveria ser específica, e é "${estado.dica}"`);
  ctx.fechar();
});

teste('pavimento que nunca teve planta não mostra distintivo nenhum', async () => {
  /* Contraprova do caso acima: sem medidas e sem arquivo registrados, não houve
     planta nenhuma — e alertar aqui transformaria todo pavimento novo num
     falso alarme. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  const oculto = await ctx.eval(`(() => {
    const floor = projects[0].floorPlans[0];
    floor.planImage = ''; floor.planWidth = 0; floor.planHeight = 0;
    floor.planFileName = ''; floor.temPlanta = false;
    renderPlanSyncStatus(floor);
    return document.querySelector('#planSyncStatus').hidden;
  })()`);

  confirmar(oculto, 'pavimento sem planta nenhuma não deveria alertar');
  ctx.fechar();
});

teste('planta que ficou sem subir aparece como não enviada, e não como pendente', async () => {
  /* O estado que antes passava despercebido: há planta no aparelho, ela não
     está na fila e o servidor não tem — é envio recusado. Mostrar isso como
     "aguardando" faria a pessoa esperar por algo que não vai acontecer. */
  const { api } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  const estado = await ctx.eval(`(() => {
    const floor = projects[0].floorPlans[0];
    floor.planImage = 'blob:http://localhost/planta-falsa';
    floor.temPlanta = false;
    renderPlanSyncStatus(floor);
    const el = document.querySelector('#planSyncStatus');
    return { texto: el.textContent, situacao: el.dataset.situacao };
  })()`);

  igual(estado.situacao, 'alerta', `deveria alertar, e indica "${estado.texto}"`);
  confirmar(/não enviada/.test(estado.texto), `o texto deveria dizer que não subiu, e é "${estado.texto}"`);
  ctx.fechar();
});

/* ------------------------------------------------------- mesma origem */

/* O painel passou a ser servido pelo próprio Worker, então painel e API vivem no
   mesmo endereço e a base da API é vazia — as chamadas saem como `/saude`.

   Isso tem uma armadilha, e é o motivo deste teste: `configurado()` usava string
   vazia para dizer "não há servidor nenhum", e base vazia é exatamente o que
   mesma origem produz. Sem a distinção, o painel servido em produção se
   declararia sem servidor e voltaria ao modo local — gravando tudo só no
   aparelho, sem sincronizar, e sem nenhum erro na tela que denunciasse isso. */
/* Registra para onde cada chamada foi, sem precisar expor nada novo no NBZApi.
   É a evidência que interessa: o endereço que de fato saiu, não o estado
   interno do cliente. */
function servidorQueRegistra() {
  const base = servidorDeTeste();
  const enderecos = [];
  return {
    ...base,
    enderecos,
    api: {
      ...base.api,
      atender: (pedido) => {
        enderecos.push(pedido.url);
        return base.api.atender(pedido);
      }
    }
  };
}

teste('servido pelo próprio Worker, o painel chama a API na própria origem', async () => {
  const { api, db, enderecos } = servidorQueRegistra();
  /* `/` é o marcador de mesma origem; no navegador real é o que a meta
     `nbz-api` carrega quando o Worker serve o index.html. */
  const ctx = await boot({ api: { ...api, endereco: '/' } });
  await pausa(600);

  confirmar(
    ctx.eval('window.NBZApi.configurado()'),
    'o painel deveria se declarar COM servidor, mesmo com a base vazia'
  );

  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });

  /* O painel roda em http://localhost no jsdom. Com mesma origem, é para lá que
     as chamadas têm de ir — e não para um host de API separado. */
  confirmar(enderecos.length > 0, 'nenhuma chamada chegou ao servidor');
  const forasteiras = enderecos.filter((url) => !url.startsWith('http://localhost/'));
  igual(forasteiras, [], 'toda chamada deveria sair na origem do painel');

  /* E o efeito: o cadastro chegou ao banco do servidor, não só ao localStorage. */
  igual(
    db.prepare('select count(*) as t from usuarios').get().t, 1,
    'o administrador deveria ter sido criado no servidor pela chamada relativa'
  );
  igual(db.prepare('select count(*) as t from sessoes').get().t, 1, 'e a sessão deveria existir');
  ctx.fechar();
});

teste('endereço absoluto continua funcionando, para o painel servido à parte', async () => {
  /* Mesma origem não pode ter substituído o modo de origem distinta: dá para
     servir o painel em outra porta apontando para a API, e é assim que roda o
     `npm run painel` contra o `wrangler dev`. */
  const { api, db, enderecos } = servidorQueRegistra();
  const ctx = await boot({ api });
  await pausa(600);

  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });

  confirmar(enderecos.length > 0, 'nenhuma chamada chegou ao servidor');
  const locais = enderecos.filter((url) => !url.startsWith('https://api-de-teste.workers.dev/'));
  igual(locais, [], 'toda chamada deveria ir ao host absoluto configurado');
  igual(db.prepare('select count(*) as t from usuarios').get().t, 1, 'o cadastro chegou ao servidor');
  ctx.fechar();
});

await executar('Painel NBZ — integração com o Worker');

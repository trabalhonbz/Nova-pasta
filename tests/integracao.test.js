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
import { adaptarD1, bancoNovo } from './d1-memoria.mjs';
import { boot, pausa, teste, confirmar, igual, executar } from './harness.js';
import worker from '../src/worker/index.js';


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

await executar('Painel NBZ — integração com o Worker');

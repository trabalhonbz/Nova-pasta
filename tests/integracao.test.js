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

teste('planta que nunca entrou na fila é recuperada pela varredura', async () => {
  /* Reproduz o que aconteceu com a primeira planta cadastrada em produção: ela
     foi importada antes de o envio existir, então ficou como data-URI no estado,
     sem entrada na fila e sem binário no IndexedDB. As dimensões subiram pelo
     /sync/subir, que sempre as carregou, e o desenho não foi a lugar nenhum —
     o banco ficou com planta_largura preenchida e planta_r2_key nula.

     Sem a varredura, nenhuma sincronização posterior corrige isso: a fila está
     vazia e nada volta a olhar para o estado. */
  const { api, db } = servidorDeTeste();
  const ctx = await boot({ api });
  await pausa(600);
  await preencherCadastroInicial(ctx, { nome: 'André', usuario: 'andre', senha: 'senhaforte1' });
  await criarObraComFoto(ctx);

  /* Planta no estado como data-URI, sem fila e sem IndexedDB — o estado exato
     de quem importou antes da mudança. */
  await ctx.eval(`(() => {
    const floor = projects[0].floorPlans[0];
    floor.planImage = ${JSON.stringify(JPEG_1X1)};
    floor.planWidth = 1800;
    floor.planHeight = 1272;
    floor.planFileName = 'N644-23-LOIM-0001-03S-HO-R00.jpg';
    floor.temPlanta = false;
    saveState();
  })()`);
  igual(ctx.eval('window.NBZApi.plantasPendentes()'), 0, 'pré-condição: a fila está vazia');

  await ctx.eval('sincronizarComServidor()');
  await pausa(600);

  const pavimento = db.prepare(
    'select planta_r2_key, planta_largura, planta_arquivo from pavimentos where id = ?'
  ).get('pav-1');
  confirmar(pavimento.planta_r2_key,
    'a varredura deveria ter enviado o binário — sem ela, planta_r2_key fica nula');
  igual(pavimento.planta_largura, 1800, 'com as dimensões que já estavam no estado');
  igual(pavimento.planta_arquivo, 'N644-23-LOIM-0001-03S-HO-R00.jpg', 'e o nome do arquivo');
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

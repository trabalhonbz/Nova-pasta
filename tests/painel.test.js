/* Bateria de testes do Painel NBZ.

   Rode com `npm test`.

   A primeira parte cobre as três correções desta rodada, cada caso reproduzindo o
   defeito original (ele falha se a correção for revertida). A segunda parte é a
   bateria de regressão dos fluxos que a correção não deveria afetar.

   Os testes de senha levam alguns segundos: o painel protege senhas com PBKDF2 de
   150 000 iterações e a suíte usa o algoritmo real, não um substituto.
*/
import {
  boot, criarAdministrador, entrar, esgotarCota, limitarCota, pausa,
  teste, confirmar, igual, executar, estilosDoPainel
} from './harness.js';

const CHAVE_OBRAS = 'nbz-gestao-obras-v1';
const CHAVE_HISTORICO = 'nbz-gestao-historico-v1';
const CHAVE_USUARIOS = 'nbz-usuarios-v1';

/* Um pavimento de 1000 m² com um setor de 100 m², que é o menor cenário capaz de
   exercitar gravação de obras, situação de área e estatísticas. */
function prepararPavimento(ctx) {
  ctx.eval(`(() => {
    projects[0].floorPlans = [prepareFloor({ id: 'f1', name: 'Térreo', area: 1000, regions: [] }, 0)];
    projects[0].floorPlans[0].regions.push({
      id: 'r1', name: 'Setor A', status: 'pending', area: 100,
      points: [{ x: 100, y: 80 }, { x: 200, y: 80 }, { x: 200, y: 180 }, { x: 100, y: 180 }],
      startDate: '', endDate: ''
    });
    saveState();
  })()`);
}

/* =======================================================================
   Correção 1 — gravação atômica de obras e histórico
   Antes: saveState() gravava obras e depois histórico. Se a segunda gravação
   estourasse a cota, a primeira já estava persistida, mas o retorno falso levava
   quem chamou a desfazer a alteração só na memória. O painel avisava "o valor
   anterior foi mantido" e, no recarregamento seguinte, a alteração reaparecia.
   ======================================================================= */

teste('cota cheia no histórico não deixa a obra gravada divergir da memória', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararPavimento(ctx);

  const liberar = esgotarCota(ctx, CHAVE_HISTORICO);
  ctx.eval(`applyRegionStatus(projects[0].id, 'f1', 'r1', 'executed')`);
  await pausa(50);
  liberar();

  const emMemoria = ctx.eval(`projects[0].floorPlans[0].regions[0].status`);
  const gravado = JSON.parse(ctx.window.localStorage.getItem(CHAVE_OBRAS))[0].floorPlans[0].regions[0].status;
  igual(emMemoria, 'pending', 'a memória deveria voltar ao valor anterior');
  igual(gravado, 'pending', 'o valor gravado deveria acompanhar a memória');
  ctx.fechar();
});

teste('cota cheia nas obras não deixa o histórico gravado divergir da memória', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararPavimento(ctx);
  const historicoAntes = ctx.window.localStorage.getItem(CHAVE_HISTORICO);

  const liberar = esgotarCota(ctx, CHAVE_OBRAS);
  ctx.eval(`applyRegionStatus(projects[0].id, 'f1', 'r1', 'executed')`);
  await pausa(50);
  liberar();

  igual(
    ctx.window.localStorage.getItem(CHAVE_HISTORICO), historicoAntes,
    'o histórico não deveria registrar uma alteração que não foi gravada'
  );
  ctx.fechar();
});

teste('falha de gravação acende o aviso de alterações não gravadas', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararPavimento(ctx);

  const liberar = esgotarCota(ctx, CHAVE_OBRAS);
  ctx.eval(`applyRegionStatus(projects[0].id, 'f1', 'r1', 'executed')`);
  await pausa(50);
  liberar();

  igual(ctx.doc.querySelector('#syncIndicator').hidden, false, 'o indicador deveria aparecer');
  ctx.fechar();
});

teste('cota cheia na presença não deixa o cadastro de equipe gravado pela metade', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  ctx.eval(`(() => {
    employees = [prepareEmployee({ id: 'e1', name: 'João Silva', code: '001', active: true })];
    attendance = [];
    saveTeamState();
  })()`);
  const cadastroAntes = ctx.window.localStorage.getItem('nbz-funcionarios-v1');

  /* O cadastro é a primeira chave gravada e a presença a segunda: alterar o cadastro
     e fazer a presença falhar é o que antes deixava a alteração gravada enquanto quem
     chamou a desfazia na memória. */
  const liberar = esgotarCota(ctx, 'nbz-presenca-v1');
  const gravou = ctx.eval(`(() => {
    employees[0].name = 'Nome Alterado';
    return saveTeamState();
  })()`);
  liberar();

  confirmar(!gravou, 'a gravação deveria ter sido recusada');
  igual(
    ctx.window.localStorage.getItem('nbz-funcionarios-v1'), cadastroAntes,
    'o cadastro gravado não deveria guardar uma alteração recusada'
  );
  ctx.fechar();
});

teste('cota cheia na presença desfaz a entrada registrada', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  ctx.eval(`(() => {
    employees = [prepareEmployee({ id: 'e1', name: 'João Silva', code: '001', active: true })];
    attendance = [];
    saveTeamState();
  })()`);

  const liberar = esgotarCota(ctx, 'nbz-presenca-v1');
  ctx.eval(`checkInEmployee('e1', projects[0].id)`);
  await pausa(50);
  liberar();

  igual(ctx.eval('attendance.length'), 0, 'a entrada deveria ser desfeita na memória');
  igual(
    JSON.parse(ctx.window.localStorage.getItem('nbz-presenca-v1')).length, 0,
    'nenhuma entrada deveria ficar gravada'
  );
  ctx.fechar();
});

/* =======================================================================
   Correção 2 — o corte do histórico acontece antes de gravar
   Antes: o corte para 150 entradas rodava depois da gravação bem-sucedida, ou seja,
   nunca na tentativa que falhava por falta de espaço. Um histórico grande deixava o
   painel preso em "alterações não gravadas" sem conseguir se recuperar sozinho.
   ======================================================================= */

/* Enche o histórico com `total` registros sem gravar, para que a gravação seguinte
   seja a primeira a enfrentar o limite. */
function encherHistorico(ctx, total) {
  ctx.eval(`activities = Array.from({ length: ${total} }, (item, index) => ({
    id: 'a' + index, text: 'Registro de atividade número ' + index, detail: 'detalhe', date: new Date().toISOString()
  }));`);
}

teste('histórico grande se corta e consegue gravar num armazenamento quase cheio', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  encherHistorico(ctx, 400);

  /* O limite aceita com folga as 150 entradas que o corte deve deixar, mas recusa as 400.
     Só grava quem cortar ANTES de tentar. */
  const umaEntrada = ctx.eval('JSON.stringify(activities[0]).length') + 1;
  const liberar = limitarCota(ctx, CHAVE_HISTORICO, umaEntrada * 220);
  const gravou = ctx.eval('saveState()');
  liberar();

  confirmar(gravou, 'a gravação deveria ter sido possível depois do corte');
  igual(ctx.eval('activities.length'), 150, 'a memória deveria ficar com 150 entradas');
  igual(
    JSON.parse(ctx.window.localStorage.getItem(CHAVE_HISTORICO)).length, 150,
    'o histórico gravado deveria ficar com 150 entradas'
  );
  igual(ctx.doc.querySelector('#syncIndicator').hidden, true, 'não deveria sobrar aviso de pendência');
  ctx.fechar();
});

teste('o corte preserva as entradas mais recentes', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  encherHistorico(ctx, 200);
  ctx.eval('saveState()');

  const gravado = JSON.parse(ctx.window.localStorage.getItem(CHAVE_HISTORICO));
  igual(gravado.length, 150, 'deveria gravar 150 entradas');
  igual(gravado[gravado.length - 1].id, 'a199', 'a última entrada deveria ser a mais recente');
  igual(gravado[0].id, 'a50', 'o corte deveria descartar as mais antigas');
  ctx.fechar();
});

/* =======================================================================
   Correção 3 — a conferência de senha honra o algoritmo gravado
   Antes: verifyPassword recalculava o hash com o algoritmo disponível no momento,
   ignorando o prefixo gravado. Um usuário criado sem `crypto.subtle` (origem não
   segura, navegador antigo, ou falha passageira do deriveBits) tinha hash
   `fallback$` e passava a ser recusado em qualquer navegador com `crypto.subtle`:
   senha certa, acesso negado e, em cinco tentativas, conta travada por 5 minutos.
   ======================================================================= */

teste('senha criada sem crypto.subtle continua válida em navegador com crypto.subtle', async () => {
  const antigo = await boot({ comCryptoSubtle: false });
  confirmar(await criarAdministrador(antigo), 'não criou o administrador no navegador antigo');
  const usuarios = antigo.window.localStorage.getItem(CHAVE_USUARIOS);
  igual(JSON.parse(usuarios)[0].hash.split('$')[0], 'fallback', 'o cenário exige hash de reserva');
  antigo.fechar();

  const atual = await boot({ seed: { [CHAVE_USUARIOS]: usuarios } });
  confirmar(await entrar(atual), `senha correta recusada: ${atual.doc.querySelector('#loginFeedback').textContent}`);
  atual.fechar();
});

teste('senha criada com crypto.subtle usa PBKDF2 e segue válida', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  const usuarios = ctx.window.localStorage.getItem(CHAVE_USUARIOS);
  igual(JSON.parse(usuarios)[0].hash.split('$')[0], 'pbkdf2', 'deveria usar PBKDF2 quando disponível');
  ctx.fechar();

  const outro = await boot({ seed: { [CHAVE_USUARIOS]: usuarios } });
  confirmar(await entrar(outro), 'senha correta recusada no mesmo algoritmo');
  outro.fechar();
});

teste('senha errada continua sendo recusada nos dois algoritmos', async () => {
  const comSubtle = await boot();
  confirmar(await criarAdministrador(comSubtle), 'não criou o administrador');
  const usuariosPbkdf2 = comSubtle.window.localStorage.getItem(CHAVE_USUARIOS);
  comSubtle.fechar();

  const a = await boot({ seed: { [CHAVE_USUARIOS]: usuariosPbkdf2 } });
  confirmar(!await entrar(a, { senha: 'errada12345' }), 'senha errada não deveria entrar (PBKDF2)');
  a.fechar();

  const semSubtle = await boot({ comCryptoSubtle: false });
  confirmar(await criarAdministrador(semSubtle), 'não criou o administrador sem subtle');
  const usuariosFallback = semSubtle.window.localStorage.getItem(CHAVE_USUARIOS);
  semSubtle.fechar();

  const b = await boot({ seed: { [CHAVE_USUARIOS]: usuariosFallback } });
  confirmar(!await entrar(b, { senha: 'errada12345' }), 'senha errada não deveria entrar (reserva)');
  b.fechar();
});

teste('hash PBKDF2 em navegador sem crypto.subtle avisa o motivo e não gasta tentativa', async () => {
  const comSubtle = await boot();
  confirmar(await criarAdministrador(comSubtle), 'não criou o administrador');
  const usuarios = comSubtle.window.localStorage.getItem(CHAVE_USUARIOS);
  comSubtle.fechar();

  const antigo = await boot({ comCryptoSubtle: false, seed: { [CHAVE_USUARIOS]: usuarios } });
  confirmar(!await entrar(antigo), 'não deveria abrir sessão sem poder conferir a senha');
  const aviso = antigo.doc.querySelector('#loginFeedback').textContent;
  confirmar(/criptografia/i.test(aviso), `o aviso deveria explicar o motivo, recebido: "${aviso}"`);
  confirmar(
    !/Tentativa/i.test(aviso),
    'uma limitação do navegador não deveria contar como tentativa de senha errada'
  );
  const portao = antigo.window.localStorage.getItem('nbz-historico-gate-v1-login');
  confirmar(!portao || JSON.parse(portao).attempts === 0, 'não deveria registrar tentativa');
  antigo.fechar();
});

/* =======================================================================
   Regressão — fluxos que as correções não deveriam afetar
   ======================================================================= */

teste('o painel inicia sem erro e pede o cadastro do administrador', async () => {
  const ctx = await boot();
  igual(ctx.errors, [], 'o boot não deveria gerar erros');
  igual(ctx.doc.querySelector('#appShell').hidden, true, 'o painel deveria começar fechado');
  igual(ctx.doc.querySelector('#authSetupForm').hidden, false, 'deveria pedir o primeiro acesso');
  ctx.fechar();
});

teste('a senha nunca é gravada em texto puro', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx, { senha: 'senhaSecreta9' }), 'não criou o administrador');
  const bruto = ctx.window.localStorage.getItem(CHAVE_USUARIOS);
  confirmar(!bruto.includes('senhaSecreta9'), 'a senha apareceu em texto puro');
  const usuario = JSON.parse(bruto)[0];
  confirmar(usuario.hash && usuario.salt, 'deveria gravar hash e sal');
  ctx.fechar();
});

teste('cinco tentativas erradas bloqueiam o login mesmo com a senha certa', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  ctx.eval('endSession("")');
  await pausa(50);

  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    await entrar(ctx, { senha: 'errada12345' });
  }
  const portao = JSON.parse(ctx.window.localStorage.getItem('nbz-historico-gate-v1-login'));
  confirmar(portao.lockedUntil > Date.now(), 'deveria bloquear após cinco tentativas');
  confirmar(!await entrar(ctx), 'o bloqueio deveria valer mesmo com a senha correta');
  ctx.fechar();
});

teste('o ambiente de testes isola as chaves e exibe a faixa', async () => {
  const ctx = await boot({ query: '?ambiente=teste' });
  igual(ctx.doc.querySelector('#testEnvironmentBanner').hidden, false, 'deveria exibir a faixa');
  confirmar(await criarAdministrador(ctx), 'não criou o administrador de teste');
  confirmar(ctx.window.localStorage.getItem('nbz-usuarios-teste-v1'), 'deveria gravar na chave de teste');
  confirmar(!ctx.window.localStorage.getItem(CHAVE_USUARIOS), 'não deveria tocar a chave de produção');
  ctx.fechar();
});

teste('o cargo de visualização não recebe permissões de escrita', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  const definicoes = new Map(JSON.parse(ctx.eval('JSON.stringify(roleDefinitions.map((r) => [r.value, r.permissions]))')));
  const cliente = [...definicoes.keys()].find((valor) => /cliente|visual/i.test(valor));
  confirmar(cliente, 'deveria existir o cargo de visualização');
  for (const permissao of ['works.edit', 'works.delete', 'users.manage', 'status.edit', 'attendance.edit', 'team.manage', 'history']) {
    confirmar(!definicoes.get(cliente).includes(permissao), `visualização não deveria ter ${permissao}`);
  }
  confirmar(definicoes.get(cliente).includes('reports'), 'visualização deveria ver relatórios');
  for (const permissao of ['users.manage', 'history', 'works.delete', 'team.manage']) {
    confirmar(definicoes.get('administrador').includes(permissao), `administrador deveria ter ${permissao}`);
  }
  ctx.fechar();
});

teste('situação de área grava, soma por situação e rejeita valor inválido', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  prepararPavimento(ctx);

  ctx.eval(`applyRegionStatus(projects[0].id, 'f1', 'r1', 'executed')`);
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'executed', 'deveria gravar a situação');
  igual(ctx.eval(`floorAreaByStatus(projects[0].floorPlans[0], 'executed')`), 100, 'deveria somar por situação');

  ctx.eval(`applyRegionStatus(projects[0].id, 'f1', 'r1', 'inventado')`);
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'executed', 'situação inválida deveria ser ignorada');
  ctx.fechar();
});

teste('presença impede entrada dupla, segunda obra e funcionário inativo', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  ctx.eval(`(() => {
    employees = [
      prepareEmployee({ id: 'e1', name: 'João Silva', code: '001', active: true }),
      prepareEmployee({ id: 'e2', name: 'Maria Souza', code: '002', active: false })
    ];
    attendance = [];
    saveTeamState();
  })()`);

  ctx.eval(`checkInEmployee('e1', projects[0].id)`);
  igual(ctx.eval('attendance.length'), 1, 'deveria registrar a entrada');
  ctx.eval(`checkInEmployee('e1', projects[0].id)`);
  igual(ctx.eval('attendance.length'), 1, 'entrada dupla deveria ser bloqueada');
  ctx.eval(`checkInEmployee('e1', projects[1].id)`);
  igual(ctx.eval('attendance.length'), 1, 'presença em duas obras deveria ser bloqueada');
  ctx.eval(`checkInEmployee('e2', projects[0].id)`);
  igual(ctx.eval('attendance.length'), 1, 'funcionário inativo não deveria receber entrada');

  ctx.eval(`checkOutEmployee(attendance[0].id)`);
  confirmar(ctx.eval('Boolean(attendance[0].checkOut)'), 'deveria registrar a saída');
  ctx.eval(`checkInEmployee('e1', projects[0].id)`);
  igual(ctx.eval('attendance.length'), 2, 'nova entrada após a saída deveria ser aceita');
  ctx.fechar();
});

teste('leitura de planilha trata separador, aspas, BOM e CRLF', async () => {
  const ctx = await boot();
  const parse = ctx.window.parseCsv;
  igual(parse('nome;matricula\nJoao;001\n'), [['nome', 'matricula'], ['Joao', '001']], 'ponto e vírgula');
  igual(parse('nome,matricula\nJoao,001\n'), [['nome', 'matricula'], ['Joao', '001']], 'vírgula');
  igual(parse('nome;empresa\n"Silva; Joao";NBZ\n'), [['nome', 'empresa'], ['Silva; Joao', 'NBZ']], 'separador entre aspas');
  igual(parse('nome\n"Joao ""Jr"" Silva"\n'), [['nome'], ['Joao "Jr" Silva']], 'aspas escapadas');
  igual(parse('﻿nome;matricula\nJoao;001\n'), [['nome', 'matricula'], ['Joao', '001']], 'BOM');
  igual(parse('nome;matricula\r\nJoao;001\r\n'), [['nome', 'matricula'], ['Joao', '001']], 'CRLF');
  ctx.fechar();
});

teste('importação classifica cadastro novo, atualização e linha ignorada', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não criou o administrador');
  ctx.eval(`(() => {
    employees = [prepareEmployee({ id: 'e1', name: 'João Silva', code: '001', company: 'NBZ', active: true })];
    saveTeamState();
  })()`);

  const plano = ctx.window.buildImportPlan(ctx.window.parseCsv(
    'nome;matricula;funcao\nJoão Silva;001;Pedreiro\nNovo Nome;003;Servente\n;004;Sem nome\nRepetido;001;Duplicado\n'
  ));
  igual(plano.counts, { create: 1, update: 1, skip: 2 }, 'contagem do plano');
  igual(plano.entries.map((item) => item.action), ['update', 'create', 'skip', 'skip'], 'ação por linha');

  let lancou = false;
  try { ctx.window.buildImportPlan(ctx.window.parseCsv('matricula;funcao\n001;Pedreiro\n')); }
  catch { lancou = true; }
  confirmar(lancou, 'planilha sem a coluna Nome deveria ser recusada');
  ctx.fechar();
});

teste('área informada e geometria de demarcação seguem consistentes', async () => {
  const ctx = await boot();
  const { parseArea, polygonArea, polygonsOverlap } = ctx.window;
  igual(parseArea('12,5'), 12.5, 'vírgula decimal');
  igual(parseArea('12.5'), 12.5, 'ponto decimal');
  confirmar(Number.isNaN(parseArea('')), 'campo vazio deveria ser NaN, não zero');
  confirmar(Number.isNaN(parseArea('abc')), 'texto deveria ser NaN');
  confirmar(Number.isNaN(parseArea('-5')), 'negativo deveria ser NaN');

  igual(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]), 50, 'retângulo 10x5');
  igual(polygonArea([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 0, 'polígono degenerado');

  const quadrado = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  confirmar(polygonsOverlap(quadrado, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }]), 'deveria detectar cruzamento');
  confirmar(!polygonsOverlap(quadrado, [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 20, y: 30 }]), 'separados não se cruzam');
  confirmar(polygonsOverlap(quadrado, [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }]), 'contido deveria contar como cruzamento');
  ctx.fechar();
});

teste('pavimento antigo com comprimento e largura é convertido em área total', async () => {
  const antigo = JSON.stringify([{
    id: 'obra-1', name: 'OBRA ANTIGA', city: 'São Paulo', client: 'Cliente', manager: 'Gestor',
    status: 'Em andamento', date: '2026-01-10', system: 'Manta asfáltica', image: '',
    floorPlans: [{ id: 'f1', name: 'Térreo', length: 20, width: 30, regions: [] }]
  }]);
  const ctx = await boot({ seed: { [CHAVE_OBRAS]: antigo, 'nbz-medicoes-demo-reset-v1': 'done' } });

  igual(ctx.eval(`projects[0].floorPlans[0].area`), 600, 'área deveria ser comprimento × largura');
  igual(ctx.eval(`'length' in projects[0].floorPlans[0]`), false, 'o campo antigo deveria sair');
  confirmar(
    ctx.window.localStorage.getItem(`${CHAVE_OBRAS}-backup-pre-area`),
    'deveria guardar a cópia anterior antes de converter'
  );
  igual(
    JSON.parse(ctx.window.localStorage.getItem(`${CHAVE_OBRAS}-backup-pre-area`))[0].floorPlans[0].length, 20,
    'a cópia deveria preservar os campos originais'
  );
  ctx.fechar();
});

/* =======================================================================
   Interface: paleta de cores dos ambientes
   ======================================================================= */

/* Um pavimento com dois setores, para conferir que pintar um não mexe no outro. */
function prepararDoisSetores(ctx) {
  ctx.eval(`(() => {
    projects[0].floorPlans = [prepareFloor({ id: 'f1', name: 'Térreo', area: 1000, regions: [] }, 0)];
    const regioes = projects[0].floorPlans[0].regions;
    regioes.push({ id: 'r1', name: 'Setor A', status: 'pending', area: 100,
      points: [{ x: 120, y: 100 }, { x: 220, y: 100 }, { x: 220, y: 200 }, { x: 120, y: 200 }], startDate: '', endDate: '' });
    regioes.push({ id: 'r2', name: 'Setor B', status: 'pending', area: 150,
      points: [{ x: 400, y: 100 }, { x: 520, y: 100 }, { x: 520, y: 220 }, { x: 400, y: 220 }], startDate: '', endDate: '' });
    saveState();
  })()`);
}

teste('a barra reúne as quatro cores, Demarcar Áreas e Fotos', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  const botoes = [...ctx.doc.querySelectorAll('#paintSwatches [data-paint]')];
  const situacoes = JSON.parse(ctx.eval('JSON.stringify(regionStatusOptions.map((o) => [o.value, o.label]))'));
  igual(botoes.length, situacoes.length + 2, 'quatro cores mais Demarcar Áreas e Fotos');

  for (const [valor, rotulo] of situacoes) {
    const botao = ctx.doc.querySelector(`#paintSwatches [data-paint="${valor}"]`);
    confirmar(botao, `deveria existir o atalho de ${valor}`);
    igual(botao.querySelector('span')?.textContent, rotulo, `o atalho de ${valor} deveria mostrar o nome`);
    confirmar(botao.querySelector('i'), `o atalho de ${valor} deveria mostrar a cor`);
  }
  igual(
    ctx.doc.querySelector('#paintSwatches [data-paint="draw"] span')?.textContent, 'Demarcar Áreas',
    'a barra deveria trazer o botão de demarcar'
  );
  igual(
    ctx.doc.querySelector('#paintSwatches [data-paint=""] span')?.textContent, 'Fotos',
    'a barra deveria manter o acesso às fotografias do local'
  );
  ctx.fechar();
});

teste('as quatro situações usam o vocabulário e as cores combinados', async () => {
  const ctx = await boot();
  const situacoes = JSON.parse(ctx.eval('JSON.stringify(regionStatusOptions.map((o) => [o.value, o.label, o.color]))'));
  igual(situacoes, [
    ['executed', 'Finalizado', '#4caf50'],
    ['inProgress', 'Executando', '#1976d2'],
    ['blocked', 'Não Liberado', '#f44336'],
    ['pending', 'Liberado', '#fdd835']
  ], 'rótulo, cor e ordem das situações');
  /* Os valores gravados não mudaram: dado antigo continua válido sem conversão. */
  igual(
    JSON.parse(ctx.eval('JSON.stringify(legacyStatusMap)')),
    { notReleased: 'blocked', released: 'pending', finished: 'executed' },
    'o mapa do vocabulário antigo deveria seguir coerente'
  );
  ctx.fechar();
});

teste('um clique na cor e um no polígono bastam para trocar a situação', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  /* Clique 1: a cor na barra do topo. */
  ctx.doc.querySelector('#paintSwatches [data-paint="blocked"]').click();
  igual(ctx.eval('paintStatus'), 'blocked', 'a cor escolhida deveria virar o pincel');

  /* Clique 2: o polígono. Sem descer a tela, sem confirmar nada. */
  ctx.eval(`(() => { const p = projects[0]; paintRegion(p, p.floorPlans[0], p.floorPlans[0].regions[0], paintStatus); })()`);
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'blocked', 'o polígono deveria assumir a cor');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[1].status`), 'pending', 'o outro polígono não deveria mudar');
  ctx.fechar();
});

teste('Demarcar Áreas entra no desenho e mostra as ações do desenho no topo', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  /* Conferir pelo estilo calculado, e não pela propriedade `hidden`: `.sketch-tools`
     declara `display:flex`, que venceria o `display:none` do atributo. */
  const exibicao = (seletor) => ctx.window.getComputedStyle(ctx.doc.querySelector(seletor)).display;
  igual(exibicao('.sketch-tools'), 'none', 'fora do desenho a fileira do desenho fica oculta');

  ctx.doc.querySelector('#paintSwatches [data-paint="draw"]').click();
  igual(ctx.eval('sketchMode'), 'draw', 'deveria entrar no modo de demarcação');
  igual(ctx.eval('paintStatus'), '', 'demarcar e pintar não podem valer ao mesmo tempo');
  confirmar(exibicao('.sketch-tools') !== 'none', 'as ações do desenho deveriam aparecer');
  confirmar(
    ctx.doc.querySelector('#paintSwatches [data-paint="draw"]').getAttribute('aria-pressed') === 'true',
    'o botão deveria ficar marcado enquanto demarca'
  );

  /* Tocar de novo volta ao normal. */
  ctx.doc.querySelector('#paintSwatches [data-paint="draw"]').click();
  igual(ctx.eval('sketchMode'), 'pan', 'deveria sair do modo de demarcação');
  ctx.fechar();
});

teste('as ferramentas ficam acima da planta, fora do menu recolhido', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  const recolhido = ctx.doc.querySelector('#planTools');
  const canvas = ctx.doc.querySelector('#sketchCanvas');
  for (const seletor of ['.paint-bar', '.sketch-tools', '.sketch-tip']) {
    const elemento = ctx.doc.querySelector(seletor);
    confirmar(elemento, `${seletor} deveria existir`);
    confirmar(!recolhido.contains(elemento), `${seletor} não deveria ficar no menu recolhido`);
    /* DOCUMENT_POSITION_FOLLOWING = 4: a planta vem depois da ferramenta. */
    confirmar(elemento.compareDocumentPosition(canvas) & 4, `${seletor} deveria ficar acima da planta`);
  }
  /* O antigo seletor Navegar/Demarcar/Selecionar saiu de cena, e com ele a fileira
     "Selecionar área / Aplicar situação / Excluir área". */
  igual(ctx.doc.querySelectorAll('[data-plan-mode]').length, 0, 'o seletor de modo deveria ter saído');
  igual(ctx.doc.querySelectorAll('.sketch-edit-tools').length, 0, 'a fileira de edição deveria ter saído');
  for (const acao of ['edit', 'apply-status', 'delete-region', 'edit-data']) {
    igual(
      ctx.doc.querySelectorAll(`[data-sketch-action="${acao}"]`).length, 0,
      `o botão ${acao} não deveria mais existir na planta`
    );
  }
  ctx.fechar();
});

teste('Fotos abre o painel do local ao tocar no polígono', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  ctx.doc.querySelector('#paintSwatches [data-paint=""]').click();
  igual(ctx.eval('paintStatus'), '', 'o modo Fotos não pinta');

  /* É o caminho que o relatório fotográfico depende: tocar no setor abre o local. */
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r1')`);
  confirmar(ctx.doc.querySelector('#localDialog').open, 'o painel do local deveria abrir');
  confirmar(
    ctx.doc.querySelector('#localContent .local-photo-actions'),
    'o painel deveria oferecer o registro de fotografias'
  );
  ctx.fechar();
});

teste('escolher a cor exige um clique e marca apenas a cor escolhida', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  const marcadas = () => [...ctx.doc.querySelectorAll('#paintSwatches [aria-pressed="true"]')].map((botao) => botao.dataset.paint);
  igual(marcadas(), ['executed'], 'ao abrir a planta a paleta já vem com uma cor ativa');

  /* Um clique na amostra basta: não há diálogo nem confirmação no caminho. */
  ctx.doc.querySelector('#paintSwatches [data-paint="pending"]').click();
  igual(marcadas(), ['pending'], 'só a cor clicada deveria ficar marcada');
  igual(ctx.eval('paintStatus'), 'pending', 'o pincel deveria passar a pintar de pendente');

  const rotulo = ctx.doc.querySelector('.paint-bar-label').textContent;
  confirmar(/Liberado/.test(rotulo), `o rótulo deveria nomear a cor ativa, recebido: "${rotulo}"`);

  ctx.doc.querySelector('#paintSwatches [data-paint=""]').click();
  igual(marcadas(), [''], 'deveria ser possível sair do modo de pintura');
  confirmar(
    /fotografias/i.test(ctx.doc.querySelector('.paint-bar-label').textContent),
    'o rótulo deveria explicar o modo Fotos'
  );
  ctx.fechar();
});

teste('pintar aplica a cor só no ambiente tocado', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);

  ctx.eval(`(() => {
    const projeto = projects[0];
    const pavimento = projeto.floorPlans[0];
    paintRegion(projeto, pavimento, pavimento.regions[0], 'executed');
  })()`);

  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'executed', 'o setor tocado deveria mudar');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[1].status`), 'pending', 'o outro setor não deveria mudar');
  igual(
    JSON.parse(ctx.window.localStorage.getItem(CHAVE_OBRAS))[0].floorPlans[0].regions[1].status, 'pending',
    'o outro setor também não deveria mudar no armazenamento'
  );
  ctx.fechar();
});

teste('pintar dá retorno visual e avisa quando a cor já está aplicada', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  const avisos = () => ctx.doc.querySelector('#toastStack').textContent;

  ctx.eval(`(() => { const p = projects[0]; paintRegion(p, p.floorPlans[0], p.floorPlans[0].regions[0], 'executed'); })()`);
  confirmar(/Setor A/.test(avisos()), `deveria avisar o que foi pintado, recebido: "${avisos()}"`);
  confirmar(/Finalizado/.test(avisos()), 'o aviso deveria nomear a cor aplicada');

  /* Tocar de novo na mesma cor não fazia nada e parecia defeito. */
  ctx.eval(`(() => { const p = projects[0]; paintRegion(p, p.floorPlans[0], p.floorPlans[0].regions[0], 'executed'); })()`);
  confirmar(/já está/i.test(avisos()), `deveria avisar que a cor já está aplicada, recebido: "${avisos()}"`);
  ctx.fechar();
});

/* =======================================================================
   Lista de pavimentos: cartão enxuto
   ======================================================================= */

teste('o cartão do pavimento não repete o seletor de situação de cada setor', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openProject(projects[0].id, 'floors')`);

  const cartao = ctx.doc.querySelector('#detailContent .detail-floor-item');
  confirmar(cartao, 'o pavimento deveria aparecer na lista');
  igual(
    cartao.querySelectorAll('[data-set-status]').length, 0,
    'o cartão não deveria trazer os botões Executado/Em Execução/Pendente/Bloqueado'
  );
  igual(cartao.querySelectorAll('.quick-status').length, 0, 'o cartão não deveria trazer o bloco de situação');
  ctx.fechar();
});

teste('o cartão mantém identificação, área, progresso e ações', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  /* Um setor executado de 420,5 m² num pavimento de 1000 m² dá 42% de progresso. */
  ctx.eval(`(() => {
    const pavimento = projects[0].floorPlans[0];
    pavimento.regions[0].area = 420.5;
    pavimento.regions[0].status = 'executed';
    saveState();
    openProject(projects[0].id, 'floors');
  })()`);

  const cartao = ctx.doc.querySelector('#detailContent .detail-floor-item');
  confirmar(/Térreo/.test(cartao.querySelector('.detail-floor-identity strong').textContent), 'deveria mostrar o nome do pavimento');
  confirmar(/1\.000/.test(cartao.querySelector('.detail-floor-identity span').textContent), 'deveria mostrar a área total');
  igual(cartao.querySelector('.detail-floor-progress').getAttribute('aria-valuenow'), '42', 'deveria mostrar o progresso');
  confirmar(/2 setor/.test(cartao.querySelector('.detail-floor-summary').textContent), 'deveria contar os setores');
  confirmar(cartao.querySelector('[data-replicate-floor]'), 'deveria manter Replicar');
  confirmar(cartao.querySelector('[data-delete-floor]'), 'deveria manter Excluir');
  confirmar(cartao.querySelector('[data-open-sketch]'), 'o cartão deveria continuar abrindo a planta');
  ctx.fechar();
});

teste('a situação do setor continua editável no painel do local', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);

  /* Tirar os seletores do cartão não pode custar a funcionalidade: ela permanece no
     painel aberto ao tocar no setor dentro da planta. */
  /* No fixture, o setor 'r2' é o segundo da lista (regions[1]). */
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r2')`);
  const seletores = ctx.doc.querySelectorAll('#localContent [data-set-status]');
  igual(
    seletores.length, JSON.parse(ctx.eval('JSON.stringify(regionStatusOptions)')).length,
    'o painel do local deveria oferecer todas as situações'
  );

  ctx.doc.querySelector('#localContent [data-set-status="executed"]').click();
  await pausa(60);
  igual(ctx.eval(`projects[0].floorPlans[0].regions[1].status`), 'executed', 'deveria aplicar a situação escolhida');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'pending', 'não deveria mexer no outro setor');
  ctx.fechar();
});

teste('o painel do local traz as mesmas amostras de cor da barra da planta', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r1')`);

  /* A barra da planta tem, além das cores, as ferramentas Demarcar Áreas e Fotos:
     a comparação é só com as cores. */
  const naPlanta = [...ctx.doc.querySelectorAll('#paintSwatches [data-paint]')]
    .filter((botao) => !botao.classList.contains('paint-tool'))
    .map((botao) => botao.querySelector('span')?.textContent);
  const noLocal = [...ctx.doc.querySelectorAll('#localContent .paint-swatches [data-set-status]')]
    .map((botao) => botao.querySelector('span')?.textContent);

  igual(noLocal, naPlanta, 'o painel deveria oferecer as mesmas cores, na mesma ordem');
  for (const botao of ctx.doc.querySelectorAll('#localContent .paint-swatches [data-set-status]')) {
    confirmar(botao.querySelector('i'), 'cada opção deveria mostrar o quadrado de cor');
    confirmar(/--sw:/.test(botao.getAttribute('style') || ''), 'cada opção deveria carregar a própria cor');
  }
  ctx.fechar();
});

teste('clicar na cor dentro do local troca a situação do setor demarcado', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  /* 'r2' é o segundo setor da lista (regions[1]). */
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r2')`);

  const marcada = () => [...ctx.doc.querySelectorAll('#localContent .paint-swatches [aria-pressed="true"]')]
    .map((botao) => botao.dataset.setStatus);
  igual(marcada(), ['pending'], 'a cor atual do local deveria vir marcada');

  ctx.doc.querySelector('#localContent [data-set-status="inProgress"]').click();
  await pausa(80);

  igual(ctx.eval(`projects[0].floorPlans[0].regions[1].status`), 'inProgress', 'deveria aplicar a cor escolhida');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'pending', 'não deveria mexer no outro local');
  igual(
    JSON.parse(ctx.window.localStorage.getItem(CHAVE_OBRAS))[0].floorPlans[0].regions[1].status, 'inProgress',
    'a troca deveria ficar gravada'
  );
  /* O painel continua aberto e acompanha a troca. */
  igual(marcada(), ['inProgress'], 'a marcação deveria passar para a cor escolhida');
  ctx.fechar();
});

teste('tocar no local na cor que já está aplicada avisa em vez de ficar em silêncio', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r2')`);

  ctx.doc.querySelector('#localContent [data-set-status="pending"]').click();
  await pausa(80);
  const avisos = ctx.doc.querySelector('#toastStack').textContent;
  confirmar(/já está/i.test(avisos), `deveria avisar que a cor já está aplicada, recebido: "${avisos}"`);
  ctx.fechar();
});

teste('o cargo sem permissão de situação não recebe as cores no local', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  /* Cliente/visualização não tem `status.edit` nem acesso a obras: o painel do local
     sequer abre para esse cargo. O cargo de relatórios é o que confirma a regra. */
  ctx.eval(`(() => {
    currentUser = { ...currentUser, role: 'cliente' };
    openLocalPanel(projects[0].id, 0, 'r2');
  })()`);
  igual(
    ctx.doc.querySelectorAll('#localContent .paint-swatches [data-set-status]').length, 0,
    'sem permissão não deveria oferecer a troca de cor'
  );
  ctx.fechar();
});

teste('tocar numa área já a seleciona, sem botão de selecionar', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  /* Sem pincel armado o toque não pinta: serve para selecionar e abrir o local. */
  ctx.doc.querySelector('#paintSwatches [data-paint=""]').click();
  igual(ctx.eval('selectedRegionId'), null, 'nada deveria estar selecionado no início');

  const area = ctx.doc.querySelector('#sketchRegions [data-region-id]');
  confirmar(area, 'a área demarcada deveria estar desenhada');
  const toque = new ctx.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
  Object.defineProperty(toque, 'pointerId', { value: 1 });
  area.dispatchEvent(toque);

  igual(ctx.eval('selectedRegionId'), area.dataset.regionId, 'o toque deveria selecionar a área');
  ctx.fechar();
});

teste('com uma área selecionada, tocar na cor do topo troca a cor na hora', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  ctx.eval(`selectedRegionId = 'r1'`);

  /* Era exatamente isto que não acontecia: o botão só armava o pincel. */
  ctx.doc.querySelector('#paintSwatches [data-paint="inProgress"]').click();
  await pausa(60);

  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'inProgress', 'a área selecionada deveria mudar de cor');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[1].status`), 'pending', 'a outra área não deveria mudar');
  igual(
    JSON.parse(ctx.window.localStorage.getItem(CHAVE_OBRAS))[0].floorPlans[0].regions[0].status, 'inProgress',
    'a troca deveria ficar gravada'
  );
  ctx.fechar();
});

teste('a seleção sobrevive à troca de cor, para aplicar várias em sequência', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  ctx.eval(`selectedRegionId = 'r1'`);

  ctx.doc.querySelector('#paintSwatches [data-paint="executed"]').click();
  await pausa(60);
  igual(ctx.eval('selectedRegionId'), 'r1', 'a área deveria continuar selecionada');
  ctx.doc.querySelector('#paintSwatches [data-paint="blocked"]').click();
  await pausa(60);
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].status`), 'blocked', 'a segunda cor também deveria valer');
  ctx.fechar();
});

teste('excluir área mora em Dados do setor, não na barra da planta', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  ctx.eval(`openSketch(projects[0].id, 0)`);
  ctx.eval(`openLocalPanel(projects[0].id, 0, 'r2')`);

  const excluir = ctx.doc.querySelector('#localDeleteRegion');
  confirmar(excluir, 'o painel do local deveria oferecer a exclusão da área');
  /* A situação já estava aqui; agora a exclusão também. */
  confirmar(ctx.doc.querySelector('#localContent .paint-swatches'), 'a situação deveria seguir no painel');

  ctx.window.confirm = () => true;
  excluir.click();
  await pausa(80);

  igual(ctx.eval(`projects[0].floorPlans[0].regions.length`), 1, 'a área deveria ter sido excluída');
  igual(ctx.eval(`projects[0].floorPlans[0].regions[0].id`), 'r1', 'a área errada não deveria sair');
  ctx.fechar();
});

/* =======================================================================
   Relatório A4: planta e fotografias
   ======================================================================= */

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* Uma visita com `total` fotografias no pavimento `f1`, mais a planta do pavimento. */
function prepararVisitaComFotos(ctx, total) {
  ctx.eval(`(() => {
    const pavimento = projects[0].floorPlans[0];
    pavimento.planImage = ${JSON.stringify(PIXEL)};
    pavimento.planWidth = 1200;
    pavimento.planHeight = 800;
    projects[0].photoReports = [{
      id: 'v1', floorId: 'f1', floorIndex: 0, floorName: pavimento.name, regionId: '',
      description: 'Visita de acompanhamento', date: new Date().toISOString(),
      photos: Array.from({ length: ${total} }, (item, index) => ({
        id: 'foto' + index, data: ${JSON.stringify(PIXEL)},
        date: new Date().toISOString(), author: 'Andre', includeInReport: true
      }))
    }];
    saveState();
  })()`);
}

teste('na tela a galeria é paginada, mas a impressão leva todas as fotografias', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  prepararVisitaComFotos(ctx, 9);

  ctx.eval('switchView("reports")');
  igual(
    ctx.doc.querySelectorAll('#reportContent .photo-gallery .gallery-cell').length, 6,
    'na tela a galeria deveria mostrar só a primeira página'
  );
  confirmar(ctx.doc.querySelector('#reportContent .gallery-more'), 'deveria oferecer o botão de ver mais');

  ctx.eval('printingReport = true; renderReports();');
  igual(
    ctx.doc.querySelectorAll('#reportContent .photo-gallery .gallery-cell').length, 9,
    'a folha impressa deveria levar todas as fotografias da visita'
  );
  ctx.fechar();
});

teste('pavimento recolhido na tela sai inteiro na impressão', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  prepararVisitaComFotos(ctx, 3);

  ctx.eval('collapsedReportFloors.add("f1"); switchView("reports");');
  confirmar(ctx.doc.querySelector('#floors-f1').hidden, 'na tela o pavimento deveria estar recolhido');

  ctx.eval('printingReport = true; renderReports();');
  confirmar(!ctx.doc.querySelector('#floors-f1').hidden, 'na impressão o pavimento deveria estar aberto');
  confirmar(ctx.doc.querySelector('#reportContent .rf-plan img'), 'a planta deveria entrar na folha');
  ctx.fechar();
});

teste('a impressão carrega as imagens de verdade em vez de deixá-las em lazy', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  prepararVisitaComFotos(ctx, 3);
  ctx.eval('switchView("reports")');

  const antes = [...ctx.doc.querySelectorAll('#reportContent img')].map((imagem) => imagem.getAttribute('loading'));
  confirmar(antes.includes('lazy'), 'na tela as imagens usam carregamento preguiçoso');

  ctx.window.print = () => {};
  ctx.doc.querySelector('#printReport').click();
  await pausa(400);

  const depois = [...ctx.doc.querySelectorAll('#reportContent img')].map((imagem) => imagem.loading);
  confirmar(depois.length > 0, 'deveria haver imagens no relatório');
  confirmar(
    depois.every((valor) => valor === 'eager'),
    `todas as imagens deveriam carregar de imediato, recebido: ${JSON.stringify(depois)}`
  );
  ctx.fechar();
});

teste('a folha impressa leva título, obra e data no próprio cabeçalho', async () => {
  const ctx = await boot();
  confirmar(await criarAdministrador(ctx), 'não abriu a sessão');
  prepararDoisSetores(ctx);
  prepararVisitaComFotos(ctx, 2);
  ctx.eval('switchView("reports")');

  /* Na tela o título e a data vivem na barra de ferramentas, que não vai para o papel:
     sem este cabeçalho a folha saía sem dizer de que obra e de quando era. */
  const cabecalho = ctx.doc.querySelector('#printHeader');
  confirmar(cabecalho, 'o relatório deveria ter um cabeçalho de impressão');
  confirmar(/Relatório de acompanhamento/.test(cabecalho.textContent), 'o cabeçalho deveria trazer o título');
  confirmar(/Todas as obras/.test(cabecalho.textContent), 'o cabeçalho deveria dizer o escopo');
  confirmar(/Gerado em \d{2}\/\d{2}\/\d{4}/.test(cabecalho.textContent), `o cabeçalho deveria trazer a data, recebido: "${cabecalho.textContent}"`);

  /* Filtrando por uma obra, o escopo acompanha. */
  const seletor = ctx.doc.querySelector('#reportProject');
  seletor.value = ctx.eval('projects[0].id');
  seletor.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  confirmar(
    new RegExp(ctx.eval('projects[0].name')).test(ctx.doc.querySelector('#printHeader').textContent),
    'o cabeçalho deveria nomear a obra filtrada'
  );

  confirmar(ctx.doc.querySelector('.report-filter'), 'o filtro de tela deveria ser marcado para sair da folha');
  ctx.fechar();
});

teste('a folha de impressão está declarada em A4 com planta e fotos em milímetros', async () => {
  /* O jsdom não calcula layout de impressão: o que se garante aqui é que as regras que
     definem a folha A4 e o tamanho das imagens continuam nas folhas de estilo. A
     conferência visual da folha é manual, pela pré-visualização de impressão do
     navegador. */
  const fonte = estilosDoPainel();
  const exigir = (padrao, mensagem) => confirmar(padrao.test(fonte), mensagem);
  exigir(/@page\{size:A4 portrait;margin:12mm 10mm\}/, 'deveria declarar a folha A4 com margens');
  exigir(/\.rf-plan img\{[^}]*max-height:150mm/, 'a planta deveria ter altura máxima em milímetros');
  exigir(/\.photo-gallery \.gallery-cell img\{[^}]*max-height:92mm/, 'as fotografias deveriam ter altura máxima em milímetros');
  exigir(/grid-template-columns:repeat\(2,1fr\)!important/, 'a folha deveria usar duas fotografias por linha');
  exigir(/\.rf-table thead\{display:table-header-group\}/, 'o cabeçalho da tabela deveria repetir a cada página');
  exigir(/\.rf-toggle,\.floor-croqui,\.gallery-more,\.report-filter\{display:none!important\}/, 'os controles de tela deveriam sair da folha');
});

await executar('Painel NBZ — bateria de testes');

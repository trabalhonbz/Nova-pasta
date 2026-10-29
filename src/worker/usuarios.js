/* Gestao de usuarios pelo administrador.

   Espelha o dialogo "Usuarios e cargos" que o painel ja tem, com a diferenca
   que importa: o cadastro passa a valer para todo mundo, em qualquer aparelho,
   em vez de so para o navegador onde foi feito.

   Quem pode o que:
   - administrador: cadastra, edita cargo, redefine senha, ativa e desativa;
   - os outros quatro cargos: so consultam a propria conta.

   A autorizacao e checada aqui, em toda funcao, e nao so na interface. O painel
   esconde botoes por cargo, mas esconder botao nao e permissao — sem a checagem
   no servidor bastaria chamar a rota direto.
*/
import { agora, novoId } from './cripto.js';
import { encerrarTodasAsSessoes, senhaDefinidaPeloAdmin } from './auth.js';

/* Os mesmos cinco de `roleDefinitions` no index.html. Divergir daqui faria o
   servidor aceitar cargo que a interface nao sabe aplicar. */
const CARGOS = ['administrador', 'engenheiro', 'encarregado', 'tecnico', 'cliente'];

function ehAdministrador(sessao) {
  return Boolean(sessao) && sessao.nivelAcesso === 'administrador';
}

function limpar(valor, tamanho) {
  return String(valor || '').trim().slice(0, tamanho);
}

/* Nome de usuario: minusculas, sem espaco, so o que da para digitar em campo de
   login sem ambiguidade. Acento fora porque teclado de celular em obra troca
   com frequencia e o login passaria a depender de qual teclado a pessoa usou. */
function normalizarLogin(valor) {
  return String(valor || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}

function paraResposta(linha) {
  return {
    id: linha.id,
    usuario: linha.usuario,
    nome: linha.nome,
    email: linha.email || '',
    nivelAcesso: linha.nivel_acesso,
    precisaTrocarSenha: linha.precisa_trocar_senha === 1,
    ativo: linha.ativo === 1,
    criadoEm: linha.criado_em
  };
}

/* ----------------------------------------------------------------- listar */

export async function listar(env, sessao) {
  if (!ehAdministrador(sessao)) {
    /* Quem nao e administrador recebe apenas a propria conta: a lista de quem
       trabalha na empresa nao precisa circular. */
    const linha = await env.DB.prepare(
      `select id, usuario, nome, email, nivel_acesso, precisa_trocar_senha, ativo, criado_em
         from usuarios where id = ?`
    ).bind(sessao.id).first();
    return { usuarios: linha ? [paraResposta(linha)] : [] };
  }

  const { results } = await env.DB.prepare(
    `select id, usuario, nome, email, nivel_acesso, precisa_trocar_senha, ativo, criado_em
       from usuarios where excluido_em is null order by nome`
  ).all();
  return { usuarios: (results || []).map(paraResposta) };
}

/* ---------------------------------------------------------------- cadastrar */

export async function cadastrar(env, sessao, corpo) {
  if (!ehAdministrador(sessao)) {
    return { erro: 'Apenas o administrador cadastra usuários.', status: 403 };
  }

  const nome = limpar(corpo && corpo.nome, 60);
  const usuario = normalizarLogin(corpo && corpo.usuario);
  const email = limpar(corpo && corpo.email, 120);
  const nivel = limpar(corpo && corpo.nivelAcesso, 20);
  const clientHash = String((corpo && corpo.clientHash) || '');
  const salt = String((corpo && corpo.salt) || '');

  if (!nome) return { erro: 'Informe o nome.', status: 400 };
  if (usuario.length < 3) return { erro: 'O usuário precisa de ao menos 3 caracteres.', status: 400 };
  if (!CARGOS.includes(nivel)) return { erro: 'Cargo inválido.', status: 400 };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { erro: 'E-mail inválido.', status: 400 };
  }

  const jaExiste = await env.DB.prepare('select id from usuarios where usuario = ?')
    .bind(usuario).first();
  if (jaExiste) return { erro: `O usuário "${usuario}" já existe.`, status: 409 };

  let senha;
  try {
    senha = await senhaDefinidaPeloAdmin(env, clientHash, salt);
  } catch {
    return { erro: 'Senha provisória em formato inválido.', status: 400 };
  }

  /* Escolha do administrador no cadastro:

     - true (padrao): a senha vale como provisoria e o primeiro login obriga a
       pessoa a definir uma propria. O administrador deixa de conhecer a senha
       de quem usa o sistema, o que importa quando um registro de obra precisa
       valer como prova de quem lancou o que.
     - false: a senha definida pelo administrador fica valendo, e a pessoa entra
       sempre com ela. Menos atrito, mas o administrador continua sabendo a
       senha de todo mundo.

     O padrao e true por ser o unico que preserva a autoria dos registros. */
  const exigirTroca = corpo && corpo.exigirTrocaDeSenha === false ? 0 : 1;

  const id = novoId();
  await env.DB.prepare(
    `insert into usuarios
       (id, usuario, nome, email, nivel_acesso, senha_hash, senha_salt, senha_iteracoes,
        precisa_trocar_senha, ativo, criado_por)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(
    id, usuario, nome, email || null, nivel,
    senha.senha_hash, senha.senha_salt, senha.senha_iteracoes, exigirTroca, sessao.id
  ).run();

  await registrar(env, sessao, 'Usuário cadastrado', `${nome} · ${usuario} · ${nivel}`);

  return {
    usuario: {
      id, usuario, nome, email, nivelAcesso: nivel,
      precisaTrocarSenha: exigirTroca === 1, ativo: true
    }
  };
}

/* ------------------------------------------------------------------ editar */

export async function editar(env, sessao, id, corpo) {
  if (!ehAdministrador(sessao)) {
    return { erro: 'Apenas o administrador altera usuários.', status: 403 };
  }

  const alvo = await env.DB.prepare(
    'select id, usuario, nome, nivel_acesso, ativo from usuarios where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!alvo) return { erro: 'Usuário não encontrado.', status: 404 };

  const nome = corpo && corpo.nome !== undefined ? limpar(corpo.nome, 60) : alvo.nome;
  const nivel = corpo && corpo.nivelAcesso !== undefined ? limpar(corpo.nivelAcesso, 20) : alvo.nivel_acesso;
  const ativo = corpo && corpo.ativo !== undefined ? (corpo.ativo ? 1 : 0) : alvo.ativo;

  if (!nome) return { erro: 'Informe o nome.', status: 400 };
  if (!CARGOS.includes(nivel)) return { erro: 'Cargo inválido.', status: 400 };

  /* Trava contra o pe no proprio pe: um administrador que se rebaixa ou se
     desativa, sendo o unico, deixa o sistema sem ninguem para cadastrar. */
  const perdeuOPoder = alvo.nivel_acesso === 'administrador' && (nivel !== 'administrador' || ativo === 0);
  if (perdeuOPoder) {
    const linha = await env.DB.prepare(
      `select count(*) as total from usuarios
        where nivel_acesso = 'administrador' and ativo = 1 and excluido_em is null and id <> ?`
    ).bind(id).first();
    if (!linha || linha.total === 0) {
      return { erro: 'Este é o único administrador ativo. Promova outro antes de alterar este.', status: 409 };
    }
  }

  await env.DB.prepare(
    'update usuarios set nome = ?, nivel_acesso = ?, ativo = ?, atualizado_em = ? where id = ?'
  ).bind(nome, nivel, ativo, agora(), id).run();

  /* Desativar ou rebaixar tem de derrubar a sessao aberta: sem isso a pessoa
     continuaria usando o sistema com o cargo antigo ate o token expirar. */
  if (ativo === 0 || nivel !== alvo.nivel_acesso) {
    await encerrarTodasAsSessoes(env, id);
  }

  await registrar(env, sessao, 'Usuário alterado', `${nome} · ${nivel}${ativo ? '' : ' · desativado'}`);
  return { ok: true };
}

/* -------------------------------------------------------- redefinir senha */

/* O administrador define uma senha provisoria nova; o primeiro login da pessoa
   obriga a troca. Nao existe "ver a senha de alguem": o que o administrador faz
   e substituir, nao consultar. */
export async function redefinirSenha(env, sessao, id, corpo) {
  if (!ehAdministrador(sessao)) {
    return { erro: 'Apenas o administrador redefine senhas.', status: 403 };
  }

  const alvo = await env.DB.prepare(
    'select id, nome, usuario from usuarios where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!alvo) return { erro: 'Usuário não encontrado.', status: 404 };

  let senha;
  try {
    senha = await senhaDefinidaPeloAdmin(
      env,
      String((corpo && corpo.clientHash) || ''),
      String((corpo && corpo.salt) || '')
    );
  } catch {
    return { erro: 'Senha provisória em formato inválido.', status: 400 };
  }

  await env.DB.prepare(
    `update usuarios
        set senha_hash = ?, senha_salt = ?, senha_iteracoes = ?,
            precisa_trocar_senha = 1, atualizado_em = ?
      where id = ?`
  ).bind(senha.senha_hash, senha.senha_salt, senha.senha_iteracoes, agora(), id).run();

  await encerrarTodasAsSessoes(env, id);
  /* As falhas acumuladas saem junto: redefinir senha para quem travou a conta
     deve devolver o acesso na hora, nao depois de esperar a janela. */
  await env.DB.prepare('delete from tentativas_login where usuario = ? and sucesso = 0')
    .bind(alvo.usuario).run();

  await registrar(env, sessao, 'Senha redefinida', `${alvo.nome} · ${alvo.usuario}`);
  return { ok: true };
}

/* ----------------------------------------------------------------- excluir */

export async function excluir(env, sessao, id) {
  if (!ehAdministrador(sessao)) {
    return { erro: 'Apenas o administrador exclui usuários.', status: 403 };
  }
  if (id === sessao.id) {
    return { erro: 'Não é possível excluir a própria conta.', status: 409 };
  }

  const alvo = await env.DB.prepare(
    'select id, nome, usuario, nivel_acesso from usuarios where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!alvo) return { erro: 'Usuário não encontrado.', status: 404 };

  if (alvo.nivel_acesso === 'administrador') {
    const linha = await env.DB.prepare(
      `select count(*) as total from usuarios
        where nivel_acesso = 'administrador' and ativo = 1 and excluido_em is null and id <> ?`
    ).bind(id).first();
    if (!linha || linha.total === 0) {
      return { erro: 'Este é o único administrador ativo.', status: 409 };
    }
  }

  /* Exclusao logica: `criado_por` e os registros de atividade apontam para este
     id, e apagar a linha de verdade deixaria o historico sem autor. */
  await env.DB.prepare('update usuarios set ativo = 0, excluido_em = ?, atualizado_em = ? where id = ?')
    .bind(agora(), agora(), id).run();
  await encerrarTodasAsSessoes(env, id);

  await registrar(env, sessao, 'Usuário excluído', `${alvo.nome} · ${alvo.usuario}`);
  return { ok: true };
}

/* --------------------------------------------------------------- estado */

/* Rota aberta, de proposito, e com uma unica informacao: se o sistema ainda
   nao tem administrador. O painel precisa dela antes de autenticar para decidir
   entre mostrar a tela de cadastro inicial ou a de login.

   Nao revela nada util a quem nao deveria ver: depois do primeiro cadastro a
   resposta e sempre a mesma, e antes dele nao existe dado a proteger. */
export async function estado(env) {
  const linha = await env.DB.prepare('select count(*) as total from usuarios').first();
  return { precisaSetup: !linha || linha.total === 0 };
}

/* ---------------------------------------------------- primeiro administrador */

/* Cadastro do primeiro administrador, equivalente a tela de setup do painel.
   So funciona com a tabela vazia — depois disso, usuario novo so pelo cadastro
   autenticado. Sem essa trava a rota seria uma porta aberta permanente. */
export async function primeiroAdministrador(env, corpo) {
  const linha = await env.DB.prepare('select count(*) as total from usuarios').first();
  if (linha && linha.total > 0) {
    return { erro: 'O sistema já tem administrador. Peça um acesso a ele.', status: 409 };
  }

  const nome = limpar(corpo && corpo.nome, 60);
  const usuario = normalizarLogin(corpo && corpo.usuario);
  const email = limpar(corpo && corpo.email, 120);

  if (!nome) return { erro: 'Informe o nome.', status: 400 };
  if (usuario.length < 3) return { erro: 'O usuário precisa de ao menos 3 caracteres.', status: 400 };

  let senha;
  try {
    senha = await senhaDefinidaPeloAdmin(
      env,
      String((corpo && corpo.clientHash) || ''),
      String((corpo && corpo.salt) || '')
    );
  } catch {
    return { erro: 'Senha em formato inválido.', status: 400 };
  }

  const id = novoId();
  await env.DB.prepare(
    `insert into usuarios
       (id, usuario, nome, email, nivel_acesso, senha_hash, senha_salt, senha_iteracoes,
        precisa_trocar_senha, ativo)
     values (?, ?, ?, ?, 'administrador', ?, ?, ?, 0, 1)`
  ).bind(id, usuario, nome, email || null, senha.senha_hash, senha.senha_salt, senha.senha_iteracoes).run();

  return { usuario: { id, usuario, nome, email, nivelAcesso: 'administrador', precisaTrocarSenha: false, ativo: true } };
}

/* ------------------------------------------------------------- atividades */

async function registrar(env, sessao, texto, detalhe) {
  await env.DB.prepare(
    'insert into atividades (id, texto, detalhe, autor_id, autor_nome) values (?, ?, ?, ?, ?)'
  ).bind(novoId(), texto, detalhe, sessao.id, sessao.nome).run();
}

/* ------------------------------------------------- obras visiveis por pessoa */

/* QUAIS OBRAS CADA PESSOA ENXERGA.

   Administrador ve todas por cargo e nao tem linha em `usuario_obras`: alocar
   obra para ele nao faria diferenca, e a lista vazia dele nao significa "nao ve
   nada". Quem consome isto precisa saber a diferenca, entao a resposta diz o
   cargo junto — `todas: true` e a forma honesta de dizer "nao se aplica".

   So o administrador consulta ou altera a alocacao de terceiros. Qualquer
   pessoa pode ver a propria: saber a que obras se tem acesso nao vaza nada que
   a propria sincronizacao ja nao entregue. */
export async function listarObras(env, sessao, id) {
  if (!ehAdministrador(sessao) && sessao.id !== id) {
    return { erro: 'Apenas o administrador consulta o acesso de outras pessoas.', status: 403 };
  }

  const alvo = await env.DB.prepare(
    'select id, nivel_acesso from usuarios where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!alvo) return { erro: 'Usuário não encontrado.', status: 404 };

  if (alvo.nivel_acesso === 'administrador') return { ok: true, todas: true, obras: [] };

  const { results } = await env.DB.prepare(
    'select obra_id from usuario_obras where usuario_id = ?'
  ).bind(id).all();
  return { ok: true, todas: false, obras: (results || []).map((linha) => linha.obra_id) };
}

/* Troca a lista inteira pela que veio, em vez de somar e tirar item a item.

   A tela envia o estado final das caixas marcadas, e e esse estado que deve
   valer. Com operacoes incrementais, uma requisicao perdida deixaria a pessoa
   com acesso que o administrador acabou de retirar — e sem nada na tela
   indicando a divergencia. */
export async function definirObras(env, sessao, id, corpo) {
  if (!ehAdministrador(sessao)) {
    return { erro: 'Apenas o administrador define o acesso às obras.', status: 403 };
  }

  const alvo = await env.DB.prepare(
    'select id, nivel_acesso from usuarios where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!alvo) return { erro: 'Usuário não encontrado.', status: 404 };
  if (alvo.nivel_acesso === 'administrador') {
    return { erro: 'Administrador já enxerga todas as obras.', status: 409 };
  }

  const pedidas = Array.isArray(corpo && corpo.obras) ? corpo.obras : [];
  if (pedidas.length > 500) return { erro: 'Lista de obras grande demais.', status: 413 };

  const ids = [...new Set(pedidas.map((obra) => limpar(obra, 64)).filter(Boolean))];

  /* So entra obra que existe. Id inventado viraria uma linha que nunca libera
     nada e que ninguem consegue desmarcar pela tela, porque a tela lista as
     obras reais. */
  let validos = [];
  if (ids.length) {
    const marcas = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `select id from obras where excluido_em is null and id in (${marcas})`
    ).bind(...ids).all();
    validos = (results || []).map((linha) => linha.id);
  }

  const instrucoes = [env.DB.prepare('delete from usuario_obras where usuario_id = ?').bind(id)];
  for (const obraId of validos) {
    instrucoes.push(env.DB.prepare(
      `insert into usuario_obras (usuario_id, obra_id, criado_por, criado_em)
       values (?, ?, ?, ?)`
    ).bind(id, obraId, sessao.id, agora()));
  }
  await env.DB.batch(instrucoes);

  return { ok: true, todas: false, obras: validos };
}

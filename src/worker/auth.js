/* Autenticacao do Worker NBZ: desafio, login, sessao e troca de senha.

   O painel ja tinha login, trava de 5 tentativas e troca de senha — tudo no
   localStorage. Este modulo move essas regras para o servidor, que e o unico
   lugar onde elas valem: a trava antiga contava no navegador de quem tentava
   entrar, e limpar os dados do site zerava o contador.

   Fluxo do login, em duas chamadas:

     1. POST /auth/desafio  { usuario }            -> { salt, iteracoes }
     2. POST /auth/login    { usuario, clientHash } -> { token, usuario }

   A primeira existe porque o PBKDF2 roda no navegador e ele precisa do salt
   antes de autenticar. Para usuario inexistente devolve-se um salt de fachada
   (ver cripto.js), de modo que a resposta nao revele quem existe.
*/
import {
  ITERACOES_PADRAO, agora, clientHashValido, expiracaoSessao, expirou,
  novoId, novoToken, protegerSenha, saltDeFachada, sha256Hex, verificarSenha
} from './cripto.js';

/* Cinco falhas em quinze minutos travam por quinze minutos — a mesma politica
   que o painel ja mostrava na interface, agora contada no servidor. */
export const MAX_TENTATIVAS = 5;
export const JANELA_MINUTOS = 15;

/* Alvo usado quando o usuario nao existe, para que o login gaste o mesmo HMAC
   e a mesma comparacao de um usuario real. São 64 zeros: um HMAC-SHA256 nunca
   produz esse valor, logo a comparacao falha sempre. */
const HASH_DE_FACHADA = '0'.repeat(64);

function minutosAtras(minutos) {
  return new Date(Date.now() - minutos * 60 * 1000).toISOString();
}

function normalizarUsuario(valor) {
  return String(valor || '').trim().toLowerCase().slice(0, 40);
}

/* --------------------------------------------------------- limite de taxa */

async function falhasRecentes(env, usuario) {
  const linha = await env.DB.prepare(
    `select count(*) as total from tentativas_login
      where usuario = ? and sucesso = 0 and quando > ?`
  ).bind(usuario, minutosAtras(JANELA_MINUTOS)).first();
  return (linha && linha.total) || 0;
}

async function registrarTentativa(env, usuario, origem, sucesso) {
  await env.DB.prepare(
    'insert into tentativas_login (usuario, origem, sucesso) values (?, ?, ?)'
  ).bind(usuario, String(origem || '').slice(0, 64), sucesso ? 1 : 0).run();
}

/* Apos login bom, as falhas anteriores daquele usuario deixam de contar — sem
   isso alguem que erra 4 vezes e acerta continuaria a um erro da trava. */
async function limparFalhas(env, usuario) {
  await env.DB.prepare(
    'delete from tentativas_login where usuario = ? and sucesso = 0'
  ).bind(usuario).run();
}

export async function minutosDeTrava(env, usuario) {
  const falhas = await falhasRecentes(env, normalizarUsuario(usuario));
  if (falhas < MAX_TENTATIVAS) return 0;
  const linha = await env.DB.prepare(
    `select quando from tentativas_login
      where usuario = ? and sucesso = 0 order by quando desc limit 1`
  ).bind(normalizarUsuario(usuario)).first();
  if (!linha) return 0;
  const liberaEm = Date.parse(linha.quando) + JANELA_MINUTOS * 60 * 1000;
  const restante = Math.ceil((liberaEm - Date.now()) / 60000);
  return restante > 0 ? restante : 0;
}

/* ---------------------------------------------------------------- desafio */

export async function desafio(env, corpo) {
  const usuario = normalizarUsuario(corpo && corpo.usuario);
  if (!usuario) return { erro: 'Informe o usuário.', status: 400 };

  const registro = await env.DB.prepare(
    'select senha_salt, senha_iteracoes from usuarios where usuario = ? and ativo = 1 and excluido_em is null'
  ).bind(usuario).first();

  if (registro) {
    return { salt: registro.senha_salt, iteracoes: registro.senha_iteracoes };
  }
  /* Usuario inexistente ou desativado recebe salt de fachada e as iteracoes
     padrao: a resposta e indistinguivel da de um usuario real. */
  return { salt: await saltDeFachada(env.PEPPER, usuario), iteracoes: ITERACOES_PADRAO };
}

/* ------------------------------------------------------------------ login */

export async function login(env, corpo, pedido) {
  const usuario = normalizarUsuario(corpo && corpo.usuario);
  const clientHash = String((corpo && corpo.clientHash) || '');
  const origem = pedido.headers.get('cf-connecting-ip') || '';

  if (!usuario || !clientHashValido(clientHash)) {
    return { erro: 'Usuário ou senha inválidos.', status: 401 };
  }

  const travado = await minutosDeTrava(env, usuario);
  if (travado > 0) {
    return {
      erro: `Muitas tentativas. Novo acesso liberado em ${travado} minuto(s).`,
      status: 429
    };
  }

  const registro = await env.DB.prepare(
    `select id, usuario, nome, email, nivel_acesso, senha_hash, precisa_trocar_senha
       from usuarios where usuario = ? and ativo = 1 and excluido_em is null`
  ).bind(usuario).first();

  /* Mesmo sem o usuario existir, gasta-se o mesmo HMAC contra um alvo de
     fachada: diferenca de tempo ou de texto entre "nao existe" e "senha
     errada" permitiria enumerar quem tem conta. O alvo e um valor fixo que
     nenhum HMAC produz, entao a comparacao sempre falha. */
  const alvo = registro ? registro.senha_hash : HASH_DE_FACHADA;
  const confere = await verificarSenha(env.PEPPER, clientHash, alvo);

  if (!registro || !confere) {
    await registrarTentativa(env, usuario, origem, false);
    const falhas = await falhasRecentes(env, usuario);
    const restantes = MAX_TENTATIVAS - falhas;
    return {
      erro: restantes > 0
        ? `Usuário ou senha inválidos. ${restantes} tentativa(s) antes do bloqueio.`
        : `Muitas tentativas. Novo acesso liberado em ${JANELA_MINUTOS} minuto(s).`,
      status: 401
    };
  }

  await registrarTentativa(env, usuario, origem, true);
  await limparFalhas(env, usuario);

  const { token, hash } = await novoToken();
  await env.DB.prepare(
    `insert into sessoes (id, token_hash, usuario_id, expira_em, user_agent)
     values (?, ?, ?, ?, ?)`
  ).bind(
    novoId(), hash, registro.id, expiracaoSessao(),
    String(pedido.headers.get('user-agent') || '').slice(0, 200)
  ).run();

  return {
    token,
    usuario: {
      id: registro.id,
      usuario: registro.usuario,
      nome: registro.nome,
      email: registro.email || '',
      nivelAcesso: registro.nivel_acesso,
      precisaTrocarSenha: registro.precisa_trocar_senha === 1
    }
  };
}

/* ---------------------------------------------------------------- sessao */

/* Le o token do header Authorization e devolve o usuario, ou null. Toda rota
   protegida passa por aqui; nenhuma consulta ao D1 deve acontecer antes. */
export async function autenticar(env, pedido) {
  const cabecalho = pedido.headers.get('authorization') || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (!token) return null;

  const hash = await sha256Hex(token);
  const linha = await env.DB.prepare(
    `select s.id as sessao_id, s.expira_em,
            u.id, u.usuario, u.nome, u.email, u.nivel_acesso, u.precisa_trocar_senha
       from sessoes s join usuarios u on u.id = s.usuario_id
      where s.token_hash = ? and u.ativo = 1 and u.excluido_em is null`
  ).bind(hash).first();

  if (!linha) return null;
  if (expirou(linha.expira_em)) {
    await env.DB.prepare('delete from sessoes where id = ?').bind(linha.sessao_id).run();
    return null;
  }

  /* `ultimo_uso` serve para a diretoria ver sessao parada e para a limpeza
     periodica; nao renova a expiracao, que e absoluta de proposito. */
  await env.DB.prepare('update sessoes set ultimo_uso = ? where id = ?')
    .bind(agora(), linha.sessao_id).run();

  return {
    sessaoId: linha.sessao_id,
    id: linha.id,
    usuario: linha.usuario,
    nome: linha.nome,
    email: linha.email || '',
    nivelAcesso: linha.nivel_acesso,
    precisaTrocarSenha: linha.precisa_trocar_senha === 1
  };
}

export async function encerrar(env, pedido) {
  const cabecalho = pedido.headers.get('authorization') || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (!token) return { ok: true };
  await env.DB.prepare('delete from sessoes where token_hash = ?')
    .bind(await sha256Hex(token)).run();
  return { ok: true };
}

/* Derruba todas as sessoes de um usuario. Usado na troca de senha e quando o
   administrador desativa alguem — sem isso a sessao aberta continuaria valida
   depois de o acesso ser revogado. */
export async function encerrarTodasAsSessoes(env, usuarioId) {
  await env.DB.prepare('delete from sessoes where usuario_id = ?').bind(usuarioId).run();
}

export async function limparSessoesExpiradas(env) {
  const resultado = await env.DB.prepare('delete from sessoes where expira_em <= ?')
    .bind(agora()).run();
  return (resultado.meta && resultado.meta.changes) || 0;
}

/* ------------------------------------------------------- troca de senha */

export async function trocarSenha(env, sessao, corpo) {
  const atual = String((corpo && corpo.clientHashAtual) || '');
  const nova = String((corpo && corpo.novoClientHash) || '');
  const salt = String((corpo && corpo.novoSalt) || '');

  if (!clientHashValido(atual) || !clientHashValido(nova)) {
    return { erro: 'Senha atual ou nova em formato inválido.', status: 400 };
  }
  if (!/^[0-9a-f]{32}$/i.test(salt)) {
    return { erro: 'Salt da nova senha em formato inválido.', status: 400 };
  }
  if (atual === nova) {
    return { erro: 'A nova senha deve ser diferente da atual.', status: 400 };
  }

  const registro = await env.DB.prepare('select senha_hash from usuarios where id = ?')
    .bind(sessao.id).first();
  if (!registro || !(await verificarSenha(env.PEPPER, atual, registro.senha_hash))) {
    return { erro: 'Senha atual incorreta.', status: 401 };
  }

  await env.DB.prepare(
    `update usuarios
        set senha_hash = ?, senha_salt = ?, senha_iteracoes = ?,
            precisa_trocar_senha = 0, atualizado_em = ?
      where id = ?`
  ).bind(
    await protegerSenha(env.PEPPER, nova), salt, ITERACOES_PADRAO, agora(), sessao.id
  ).run();

  /* Trocar a senha derruba as outras sessoes: se a troca foi por suspeita de
     acesso indevido, deixar a sessao do invasor aberta anularia o motivo. */
  await encerrarTodasAsSessoes(env, sessao.id);

  return { ok: true, reautenticar: true };
}

/* Senha definida pelo administrador no cadastro ou na redefinicao.

   O salt vem do cliente, nao e gerado aqui: quem calculou o PBKDF2 foi o
   navegador do administrador, e guardar um salt diferente do que entrou nesse
   calculo tornaria a senha provisoria impossivel de conferir no login. */
export async function senhaDefinidaPeloAdmin(env, clientHash, salt) {
  if (!clientHashValido(clientHash)) throw new Error('clientHash em formato invalido.');
  if (!/^[0-9a-f]{32}$/i.test(String(salt || ''))) throw new Error('salt em formato invalido.');
  return {
    senha_hash: await protegerSenha(env.PEPPER, clientHash),
    senha_salt: String(salt).toLowerCase(),
    senha_iteracoes: ITERACOES_PADRAO
  };
}

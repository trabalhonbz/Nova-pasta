/* Worker NBZ: ponto de entrada e roteamento.

   Publicar:  npx wrangler deploy
   Segredo:   npx wrangler secret put PEPPER

   Regra que vale para toda rota protegida: a sessao e resolvida ANTES de
   qualquer consulta de dados, e a autorizacao e conferida no modulo que trata
   o pedido. O painel esconde botao por cargo, mas esconder botao nao e
   permissao — sem a checagem aqui bastaria chamar a rota direto.
*/
import {
  autenticar, desafio, encerrar, limparSessoesExpiradas, login, trocarSenha
} from './auth.js';
import * as fotos from './fotos.js';
import * as sync from './sync.js';
import * as usuarios from './usuarios.js';

/* ------------------------------------------------------------- respostas */

function json(dados, status = 200, origem = '') {
  return new Response(JSON.stringify(dados), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      /* O painel guarda dados de obra; nenhuma resposta da API deve ficar em
         cache intermediario. As imagens, que podem, tem cabecalho proprio. */
      'cache-control': 'no-store',
      ...cabecalhosCors(origem)
    }
  });
}

/* Resposta de erro ja no formato que o painel espera em `erro`. */
function erro(mensagem, status = 400, origem = '') {
  return json({ erro: mensagem }, status, origem);
}

/* ------------------------------------------------------------------ CORS */

/* `ORIGENS` e lista separada por virgula, configurada no wrangler.toml. Nao se
   usa `*` porque o painel manda o header Authorization: com credencial em
   jogo, liberar qualquer origem deixaria qualquer site autenticado chamar a
   API em nome do usuario. */
function origemPermitida(env, pedido) {
  const pedida = pedido.headers.get('origin') || '';
  if (!pedida) return '';
  const lista = String(env.ORIGENS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return lista.includes(pedida) ? pedida : '';
}

function cabecalhosCors(origem) {
  if (!origem) return {};
  return {
    'access-control-allow-origin': origem,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

/* ------------------------------------------------------------ utilitarios */

async function corpoJson(pedido) {
  try {
    const dados = await pedido.json();
    return dados && typeof dados === 'object' ? dados : {};
  } catch {
    return {};
  }
}

/* Converte o retorno dos modulos — que devolvem `{erro, status}` ou os dados —
   numa Response. Centralizar isso evita repetir o mesmo if em cada rota. */
function responder(resultado, origem, statusOk = 200) {
  if (resultado && resultado.erro) {
    return erro(resultado.erro, resultado.status || 400, origem);
  }
  return json(resultado, statusOk, origem);
}

/* ------------------------------------------------------------ roteamento */

async function rotear(pedido, env, contexto) {
  const url = new URL(pedido.url);
  const caminho = url.pathname.replace(/\/+$/, '') || '/';
  const metodo = pedido.method.toUpperCase();
  const origem = origemPermitida(env, pedido);
  const parametros = url.searchParams;

  if (metodo === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cabecalhosCors(origem) });
  }

  /* O clientHash trafega no lugar da senha; sem TLS ele iria em claro. O
     workers.dev e sempre https, mas um dominio proprio mal configurado nao. */
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return erro('Esta API exige HTTPS.', 400, origem);
  }

  if (!env.PEPPER) {
    /* Sem o segredo, nenhuma senha pode ser conferida. Falhar alto e melhor que
       atender com verificacao quebrada. */
    return erro('Servidor sem PEPPER configurado. Rode: wrangler secret put PEPPER', 500, origem);
  }

  if (caminho === '/saude' && metodo === 'GET') {
    return json({ ok: true, agora: new Date().toISOString() }, 200, origem);
  }

  /* ------------------------------------------------------- rotas abertas */

  if (caminho === '/auth/estado' && metodo === 'GET') {
    return responder(await usuarios.estado(env), origem);
  }
  if (caminho === '/auth/setup' && metodo === 'POST') {
    return responder(await usuarios.primeiroAdministrador(env, await corpoJson(pedido)), origem, 201);
  }
  if (caminho === '/auth/desafio' && metodo === 'POST') {
    return responder(await desafio(env, await corpoJson(pedido)), origem);
  }
  if (caminho === '/auth/login' && metodo === 'POST') {
    return responder(await login(env, await corpoJson(pedido), pedido), origem);
  }
  if (caminho === '/auth/sair' && metodo === 'POST') {
    return responder(await encerrar(env, pedido), origem);
  }

  /* ---------------------------------------------------- rotas protegidas */

  const sessao = await autenticar(env, pedido);
  if (!sessao) return erro('Sessão expirada. Entre novamente.', 401, origem);

  if (caminho === '/auth/eu' && metodo === 'GET') {
    return json({ usuario: sessao }, 200, origem);
  }
  if (caminho === '/auth/senha' && metodo === 'POST') {
    return responder(await trocarSenha(env, sessao, await corpoJson(pedido)), origem);
  }

  /* Quem esta com senha provisoria so pode trocar a senha e sair. Liberar o
     resto antes da troca anularia a obrigacao. */
  if (sessao.precisaTrocarSenha) {
    return erro('Troque a senha provisória antes de continuar.', 428, origem);
  }

  if (caminho === '/usuarios') {
    if (metodo === 'GET') return responder(await usuarios.listar(env, sessao), origem);
    if (metodo === 'POST') {
      return responder(await usuarios.cadastrar(env, sessao, await corpoJson(pedido)), origem, 201);
    }
  }

  const usuarioSenha = caminho.match(/^\/usuarios\/([^/]+)\/senha$/);
  if (usuarioSenha && metodo === 'POST') {
    return responder(
      await usuarios.redefinirSenha(env, sessao, usuarioSenha[1], await corpoJson(pedido)),
      origem
    );
  }

  const usuarioId = caminho.match(/^\/usuarios\/([^/]+)$/);
  if (usuarioId) {
    if (metodo === 'PATCH') {
      return responder(await usuarios.editar(env, sessao, usuarioId[1], await corpoJson(pedido)), origem);
    }
    if (metodo === 'DELETE') {
      return responder(await usuarios.excluir(env, sessao, usuarioId[1]), origem);
    }
  }

  if (caminho === '/sync/subir' && metodo === 'POST') {
    return responder(await sync.subir(env, sessao, await corpoJson(pedido)), origem);
  }
  if (caminho === '/sync/baixar' && metodo === 'GET') {
    return responder(await sync.baixar(env, sessao, parametros), origem);
  }

  if (caminho === '/fotos' && metodo === 'POST') {
    return responder(await fotos.enviar(env, sessao, pedido, parametros), origem, 201);
  }

  const fotoId = caminho.match(/^\/fotos\/([^/]+)$/);
  if (fotoId) {
    /* `servir` devolve a imagem, nao JSON: o `<img src>` do painel aponta
       direto para esta rota. */
    if (metodo === 'GET') return fotos.servir(env, sessao, fotoId[1], pedido);
    if (metodo === 'DELETE') return responder(await fotos.excluir(env, sessao, fotoId[1]), origem);
  }

  if (caminho === '/plantas' && metodo === 'POST') {
    return responder(await fotos.enviarPlanta(env, sessao, pedido, parametros), origem, 201);
  }

  const plantaId = caminho.match(/^\/plantas\/([^/]+)$/);
  if (plantaId && metodo === 'GET') {
    return fotos.servirPlanta(env, sessao, plantaId[1], pedido);
  }

  return erro(`Rota não encontrada: ${metodo} ${caminho}`, 404, origem);
}

export default {
  async fetch(pedido, env, contexto) {
    try {
      return await rotear(pedido, env, contexto);
    } catch (falha) {
      /* A mensagem da excecao pode conter trecho de SQL ou nome de coluna, que
         nao deve chegar ao cliente. O detalhe fica no log do Worker. */
      console.error('Falha não tratada:', falha && falha.stack ? falha.stack : falha);
      return new Response(
        JSON.stringify({ erro: 'Erro interno. Tente novamente.' }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
      );
    }
  },

  /* Limpeza diaria das sessoes vencidas, agendada no wrangler.toml. Sem ela a
     tabela cresce para sempre e as leituras do D1 (5M/dia no plano gratuito)
     passariam a varrer lixo. */
  async scheduled(evento, env, contexto) {
    contexto.waitUntil(
      limparSessoesExpiradas(env)
        .then((total) => console.log(`Sessões expiradas removidas: ${total}`))
        .catch((falha) => console.error('Falha na limpeza de sessões:', falha))
    );
  }
};

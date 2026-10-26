/* Cliente do Worker NBZ: autenticacao, usuarios e envio de fotos.

   Este arquivo e a unica parte do painel que conhece a rede. O resto do
   index.html continua chamando funcoes locais — e o que permite o painel
   seguir funcionando offline, que e a situacao normal dentro de obra.

   DIVISAO DO CALCULO DA SENHA

   O PBKDF2 roda aqui, no navegador, e nao no servidor: o plano gratuito do
   Workers da 10 ms de CPU por request e o PBKDF2 custa 75 ms. O que vai para a
   rede e o `clientHash`; o servidor aplica um HMAC com segredo proprio antes de
   guardar. Ver o cabecalho de src/worker/cripto.js para o que isso garante.

   ONDE O TOKEN FICA

   No localStorage, nao no sessionStorage. O painel e PWA usado em celular: com
   sessionStorage, fechar o aplicativo derrubaria a sessao e o engenheiro teria
   de digitar senha a cada visita, no meio da obra, as vezes sem sinal para
   autenticar de novo. O bloqueio por inatividade continua na interface.

   FILA DE ENVIO

   Foto tirada sem sinal nao pode se perder nem travar a tela. O binario fica no
   IndexedDB (src/db.js) e aqui guarda-se apenas a lista de ids por enviar. Ao
   voltar a conexao a fila escoa sozinha.
*/
(function (global) {
  'use strict';

  const CHAVE_TOKEN = 'nbz-token-v1';
  const CHAVE_USUARIO = 'nbz-usuario-v1';
  const CHAVE_FILA = 'nbz-fila-envio-v1';
  const CHAVE_ENVIADAS = 'nbz-fotos-enviadas-v1';
  const CHAVE_BASE = 'nbz-api-base-v1';

  const codificador = new TextEncoder();
  let baseUrl = '';
  let aoMudarFila = null;
  let escoando = false;

  /* -------------------------------------------------------- armazenamento */

  function ler(chave, padrao = null) {
    try {
      const bruto = global.localStorage.getItem(chave);
      return bruto === null ? padrao : JSON.parse(bruto);
    } catch {
      return padrao;
    }
  }

  function gravar(chave, valor) {
    try {
      if (valor === null) global.localStorage.removeItem(chave);
      else global.localStorage.setItem(chave, JSON.stringify(valor));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ configuracao */

  function configurar(endereco) {
    baseUrl = String(endereco || '').replace(/\/+$/, '');
    gravar(CHAVE_BASE, baseUrl);
    return baseUrl;
  }

  function base() {
    if (!baseUrl) baseUrl = ler(CHAVE_BASE, '') || '';
    return baseUrl;
  }

  /* `false` significa "sem servidor configurado": o painel continua inteiro no
     armazenamento local, como antes de existir API. */
  function configurado() {
    return Boolean(base());
  }

  function online() {
    return configurado() && global.navigator.onLine !== false;
  }

  /* ------------------------------------------------------------------ sessao */

  function token() {
    return ler(CHAVE_TOKEN, '') || '';
  }

  function usuarioAtual() {
    return ler(CHAVE_USUARIO, null);
  }

  function guardarSessao(dados) {
    gravar(CHAVE_TOKEN, dados && dados.token ? dados.token : null);
    gravar(CHAVE_USUARIO, dados && dados.usuario ? dados.usuario : null);
  }

  function limparSessao() {
    gravar(CHAVE_TOKEN, null);
    gravar(CHAVE_USUARIO, null);
  }

  /* ------------------------------------------------------------- transporte */

  /* Erro com `status` e `offline` para que quem chama distinga "o servidor
     recusou" de "nao deu para falar com o servidor" — a primeira situacao é
     para mostrar ao usuario, a segunda para enfileirar e tentar depois. */
  function falha(mensagem, status = 0, offline = false) {
    const erro = new Error(mensagem);
    erro.status = status;
    erro.offline = offline;
    return erro;
  }

  async function chamar(rota, { metodo = 'GET', corpo = null, bruto = null, autenticado = true } = {}) {
    if (!configurado()) throw falha('Servidor não configurado.', 0, true);

    const cabecalhos = {};
    if (autenticado) {
      const atual = token();
      if (!atual) throw falha('Sessão expirada. Entre novamente.', 401);
      cabecalhos.authorization = `Bearer ${atual}`;
    }
    if (corpo !== null) cabecalhos['content-type'] = 'application/json';

    let resposta;
    try {
      resposta = await global.fetch(`${base()}${rota}`, {
        method: metodo,
        headers: cabecalhos,
        body: corpo !== null ? JSON.stringify(corpo) : bruto
      });
    } catch {
      /* Rede fora, DNS, servidor dormindo: nenhum deles é erro do usuario. */
      throw falha('Sem conexão com o servidor.', 0, true);
    }

    if (resposta.status === 401 && autenticado) {
      limparSessao();
      throw falha('Sessão expirada. Entre novamente.', 401);
    }

    const tipo = resposta.headers.get('content-type') || '';
    const dados = tipo.includes('application/json') ? await resposta.json().catch(() => ({})) : {};

    if (!resposta.ok) {
      throw falha(dados.erro || `Falha na requisição (${resposta.status}).`, resposta.status);
    }
    return dados;
  }

  /* ------------------------------------------------------------ senha */

  function paraHex(bytes) {
    return Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function novoSalt() {
    return paraHex(global.crypto.getRandomValues(new Uint8Array(16)));
  }

  /* O mesmo PBKDF2 que o painel ja usava para guardar senha localmente, agora
     servindo para provar a senha ao servidor sem envia-la. */
  async function calcularClientHash(senha, salt, iteracoes) {
    const chave = await global.crypto.subtle.importKey(
      'raw', codificador.encode(String(senha)), 'PBKDF2', false, ['deriveBits']
    );
    const bits = await global.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: codificador.encode(String(salt)),
        iterations: Number(iteracoes) || 210000
      },
      chave, 256
    );
    return paraHex(bits);
  }

  /* ---------------------------------------------------------------- login */

  async function entrar(usuario, senha) {
    const alvo = await chamar('/auth/desafio', {
      metodo: 'POST', corpo: { usuario }, autenticado: false
    });
    const clientHash = await calcularClientHash(senha, alvo.salt, alvo.iteracoes);
    const sessao = await chamar('/auth/login', {
      metodo: 'POST', corpo: { usuario, clientHash }, autenticado: false
    });
    guardarSessao(sessao);
    return sessao.usuario;
  }

  async function sair() {
    try {
      await chamar('/auth/sair', { metodo: 'POST' });
    } catch {
      /* Sair offline ainda deve limpar o aparelho; a sessao no servidor expira
         sozinha em 12 h. */
    }
    limparSessao();
  }

  async function primeiroAdministrador({ nome, usuario, email, senha }) {
    const salt = novoSalt();
    const clientHash = await calcularClientHash(senha, salt, 210000);
    const criado = await chamar('/auth/setup', {
      metodo: 'POST',
      corpo: { nome, usuario, email, clientHash, salt },
      autenticado: false
    });
    return criado.usuario;
  }

  async function trocarSenha(senhaAtual, senhaNova) {
    const atual = usuarioAtual();
    if (!atual) throw falha('Sessão expirada. Entre novamente.', 401);

    /* A senha atual é conferida com o salt que esta valendo; a nova ganha salt
       proprio, gerado aqui, e o servidor guarda esse mesmo salt. */
    const desafio = await chamar('/auth/desafio', {
      metodo: 'POST', corpo: { usuario: atual.usuario }, autenticado: false
    });
    const novoSaltSenha = novoSalt();
    const resultado = await chamar('/auth/senha', {
      metodo: 'POST',
      corpo: {
        clientHashAtual: await calcularClientHash(senhaAtual, desafio.salt, desafio.iteracoes),
        novoClientHash: await calcularClientHash(senhaNova, novoSaltSenha, 210000),
        novoSalt: novoSaltSenha
      }
    });
    /* A troca derruba as sessoes, inclusive esta: o painel tem de pedir login. */
    if (resultado.reautenticar) limparSessao();
    return resultado;
  }

  /* Rota aberta: diz apenas se o sistema ainda não tem administrador. O painel
     usa isso para escolher entre a tela de cadastro inicial e a de login. */
  function estadoDoServidor() {
    return chamar('/auth/estado', { autenticado: false });
  }

  async function eu() {
    const dados = await chamar('/auth/eu');
    gravar(CHAVE_USUARIO, dados.usuario);
    return dados.usuario;
  }

  /* -------------------------------------------------------------- usuarios */

  async function listarUsuarios() {
    const dados = await chamar('/usuarios');
    return dados.usuarios || [];
  }

  async function cadastrarUsuario({ nome, usuario, email, nivelAcesso, senha, exigirTrocaDeSenha = true }) {
    const salt = novoSalt();
    const dados = await chamar('/usuarios', {
      metodo: 'POST',
      corpo: {
        nome, usuario, email, nivelAcesso, salt,
        clientHash: await calcularClientHash(senha, salt, 210000),
        exigirTrocaDeSenha
      }
    });
    return dados.usuario;
  }

  function editarUsuario(id, dados) {
    return chamar(`/usuarios/${encodeURIComponent(id)}`, { metodo: 'PATCH', corpo: dados });
  }

  async function redefinirSenhaDe(id, senha) {
    const salt = novoSalt();
    return chamar(`/usuarios/${encodeURIComponent(id)}/senha`, {
      metodo: 'POST',
      corpo: { salt, clientHash: await calcularClientHash(senha, salt, 210000) }
    });
  }

  function excluirUsuario(id) {
    return chamar(`/usuarios/${encodeURIComponent(id)}`, { metodo: 'DELETE' });
  }

  /* ------------------------------------------------------- fila de fotos */

  function fila() {
    const lista = ler(CHAVE_FILA, []);
    return Array.isArray(lista) ? lista : [];
  }

  function salvarFila(lista) {
    gravar(CHAVE_FILA, lista);
    if (typeof aoMudarFila === 'function') aoMudarFila(lista.length);
  }

  function pendentes() {
    return fila().length;
  }

  /* Enfileira a foto. O binario já está no IndexedDB sob o mesmo id, então aqui
     só entra a referência — a fila nunca duplica imagem. */
  function enfileirarFoto(fotoId, relatorioId, meta = {}) {
    const lista = fila();
    if (lista.some((item) => item.fotoId === fotoId)) return pendentes();
    lista.push({ fotoId, relatorioId, meta, tentativas: 0, desde: new Date().toISOString() });
    salvarFila(lista);
    return lista.length;
  }

  function removerDaFila(fotoId) {
    salvarFila(fila().filter((item) => item.fotoId !== fotoId));
  }

  /* Ids que ja estao no servidor. Serve para a varredura do painel nao
     reenfileirar o que subiu — sem esta lista, toda sincronizacao recolocaria
     todas as fotos na fila e o upload seria refeito do zero a cada vez. */
  function fotosEnviadas() {
    const lista = ler(CHAVE_ENVIADAS, []);
    return new Set(Array.isArray(lista) ? lista : []);
  }

  function marcarEnviada(fotoId) {
    const lista = ler(CHAVE_ENVIADAS, []);
    const atual = Array.isArray(lista) ? lista : [];
    if (atual.includes(fotoId)) return;
    atual.push(fotoId);
    /* Limite de guarda: a lista so cresce, e num aparelho usado por anos ela
       passaria do tamanho util. As mais antigas ja nao sao reenfileiradas
       porque tambem sairam do estado local. */
    gravar(CHAVE_ENVIADAS, atual.length > 5000 ? atual.slice(-5000) : atual);
  }

  async function enviarUma(item) {
    const midia = global.NBZMidia;
    if (!midia) throw falha('Camada de mídia indisponível.', 0, true);

    const registro = await midia.lerRegistro(item.fotoId);
    if (!registro) {
      /* O binario sumiu (aparelho limpo, foto apagada): sem ele nao ha o que
         enviar, e manter na fila repetiria a falha para sempre. */
      removerDaFila(item.fotoId);
      return { id: item.fotoId, descartada: true };
    }

    const consulta = new URLSearchParams({
      relatorio: item.relatorioId,
      id: item.fotoId,
      largura: String((item.meta && item.meta.largura) || 0),
      altura: String((item.meta && item.meta.altura) || 0)
    });
    if (item.meta && item.meta.legenda) consulta.set('legenda', item.meta.legenda);

    const enviada = await chamar(`/fotos?${consulta.toString()}`, {
      metodo: 'POST',
      bruto: new global.Blob([registro.dados], { type: registro.tipo || 'image/jpeg' })
    });
    removerDaFila(item.fotoId);
    marcarEnviada(item.fotoId);
    return enviada.foto;
  }

  /* Escoa a fila inteira. Reentrante por `escoando`: o evento `online` e o
     temporizador podem disparar juntos, e dois escoamentos em paralelo
     enviariam a mesma foto duas vezes. */
  async function escoarFila() {
    if (escoando || !online() || !token()) return { enviadas: 0, pendentes: pendentes() };
    escoando = true;
    let enviadas = 0;
    try {
      for (const item of fila()) {
        try {
          await enviarUma(item);
          enviadas += 1;
        } catch (erro) {
          /* Falha de rede: para o escoamento e tenta no proximo gatilho, sem
             consumir a fila. Recusa do servidor (4xx) nao melhora com repeticao,
             então sai da fila para nao bloquear as outras. */
          if (erro.offline || erro.status === 0) break;
          if (erro.status >= 400 && erro.status < 500 && erro.status !== 429) {
            removerDaFila(item.fotoId);
          } else {
            break;
          }
        }
      }
    } finally {
      escoando = false;
    }
    return { enviadas, pendentes: pendentes() };
  }

  /* ------------------------------------------------- baixar foto do servidor */

  /* Traz o binario e o guarda no IndexedDB, devolvendo o object URL local.

     Por que baixar em vez de apontar `<img src>` para o servidor: `<img>` nao
     manda cabecalho Authorization, e a rota exige sessao. Poderia-se pendurar o
     token na querystring, mas token em URL vaza em log de servidor, historico
     do navegador e no campo Referer.

     Baixar uma vez tem outra vantagem, que no fim importa mais: a foto passa a
     existir no aparelho, e a galeria continua abrindo dentro da obra sem sinal. */
  async function baixarFoto(fotoId) {
    if (!configurado() || !token()) return '';
    const midia = global.NBZMidia;
    if (!midia) return '';

    /* Se o binario ja esta aqui, nao se gasta rede: as fotos sao imutaveis —
       substituir uma gera id novo. */
    const existente = await midia.lerRegistro(fotoId);
    if (existente) return midia.urlDaFoto(fotoId);

    let resposta;
    try {
      resposta = await global.fetch(`${base()}/fotos/${encodeURIComponent(fotoId)}`, {
        headers: { authorization: `Bearer ${token()}` }
      });
    } catch {
      return '';
    }
    if (!resposta.ok) return '';

    const tipo = resposta.headers.get('content-type') || 'image/jpeg';
    const dados = await resposta.arrayBuffer();
    if (!dados || !dados.byteLength) return '';

    const guardou = await midia.guardarFoto(fotoId, new global.Blob([dados], { type: tipo }));
    return guardou ? midia.urlDaFoto(fotoId) : '';
  }

  /* --------------------------------------------------------- sincronizacao */

  const CHAVE_MARCA = 'nbz-sync-desde-v1';

  function subirEstado(obras) {
    return chamar('/sync/subir', { metodo: 'POST', corpo: { obras } });
  }

  /* `desde` guarda o carimbo da ultima descida bem-sucedida, para que a
     proxima traga so o que mudou — e nao a base inteira a cada abertura. */
  async function baixarEstado({ completo = false } = {}) {
    const desde = completo ? '' : (ler(CHAVE_MARCA, '') || '');
    const consulta = desde ? `?desde=${encodeURIComponent(desde)}` : '';
    const pacote = await chamar(`/sync/baixar${consulta}`);
    if (pacote && pacote.em) gravar(CHAVE_MARCA, pacote.em);
    return pacote;
  }

  function esquecerMarcaDeSync() {
    gravar(CHAVE_MARCA, null);
  }

  function observarFila(callback) {
    aoMudarFila = callback;
  }

  /* Gatilhos de escoamento: voltar a ficar online e a cada 2 min, para o caso
     de o evento nao disparar (comum em celular trocando de torre). */
  function iniciar() {
    global.addEventListener('online', () => { escoarFila(); });
    global.setInterval(() => { escoarFila(); }, 120000);
    if (online() && token()) escoarFila();
  }

  global.NBZApi = {
    configurar,
    configurado,
    online,
    token,
    usuarioAtual,
    limparSessao,
    calcularClientHash,
    novoSalt,
    entrar,
    sair,
    eu,
    estadoDoServidor,
    primeiroAdministrador,
    trocarSenha,
    listarUsuarios,
    cadastrarUsuario,
    editarUsuario,
    redefinirSenhaDe,
    excluirUsuario,
    enfileirarFoto,
    escoarFila,
    fotosEnviadas,
    pendentes,
    observarFila,
    baixarFoto,
    subirEstado,
    baixarEstado,
    esquecerMarcaDeSync,
    iniciar
  };
})(typeof window !== 'undefined' ? window : globalThis);

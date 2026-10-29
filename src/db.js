/* Camada de persistência de imagens do Painel NBZ.

   Por que ela existe: o painel guardava as fotos como data-URI base64 dentro do
   mesmo JSON do localStorage. Três problemas vinham junto:

   - o localStorage tem ~5 MB por domínio, e cada foto comprimida ocupa ~250 KB
     em base64, então por volta de 15 a 20 fotos o `saveState()` começava a
     falhar com "Sem espaço para salvar as fotos neste navegador";
   - base64 infla o binário em 33% — a mesma foto que pesa 190 KB como JPEG
     ocupa 250 KB como texto;
   - `localStorage.setItem` é síncrono, então gravar megabytes travava a tela.

   O que esta camada faz: o binário vai para o IndexedDB como Blob (capacidade
   em centenas de MB, sem inflar, assíncrono) e o JSON do estado passa a guardar
   apenas o id da foto. Na leitura, cada Blob ganha um object URL.

   A decisão que mantém a cirurgia pequena: o object URL é atribuído de volta em
   `photo.data`. O painel usa `photo.data` em nove pontos, seis deles dentro de
   `<img src="${photo.data}">` — como object URL e data-URI são ambos strings
   aceitas em `src`, esses pontos não precisam mudar.

   Quando o IndexedDB não existe (modo privado de alguns navegadores, origem não
   segura, navegador antigo), `disponivel()` responde false e o painel continua
   no comportamento antigo de base64 no localStorage. Degradar é melhor que
   deixar o engenheiro sem registrar a visita.
*/
(function (global) {
  'use strict';

  const NOME_BANCO = 'nbz-obras-midia';
  const VERSAO = 1;
  const LOJA_FOTOS = 'fotos';

  let conexao = null;
  let tentativaAbertura = null;
  let suportado = null;

  /* Cache de object URL por id. Sem ele, cada `renderAll()` criaria URLs novas
     para as mesmas fotos e o navegador seguraria todos os Blobs na memória até
     a página ser fechada. */
  const urlsAtivas = new Map();

  function temIndexedDB() {
    try {
      return typeof global.indexedDB === 'object' && global.indexedDB !== null;
    } catch {
      /* Alguns navegadores lançam SecurityError só ao tocar na propriedade. */
      return false;
    }
  }

  function abrir() {
    if (conexao) return Promise.resolve(conexao);
    if (tentativaAbertura) return tentativaAbertura;
    if (!temIndexedDB()) {
      suportado = false;
      return Promise.resolve(null);
    }

    tentativaAbertura = new Promise((resolve) => {
      let pedido;
      try {
        pedido = global.indexedDB.open(NOME_BANCO, VERSAO);
      } catch {
        suportado = false;
        resolve(null);
        return;
      }

      pedido.onupgradeneeded = () => {
        const banco = pedido.result;
        if (!banco.objectStoreNames.contains(LOJA_FOTOS)) {
          banco.createObjectStore(LOJA_FOTOS, { keyPath: 'id' });
        }
      };
      pedido.onsuccess = () => {
        conexao = pedido.result;
        suportado = true;
        /* Se outra aba pedir uma versão maior, soltamos a conexão em vez de
           bloquear o upgrade dela indefinidamente. */
        conexao.onversionchange = () => {
          conexao.close();
          conexao = null;
          tentativaAbertura = null;
        };
        resolve(conexao);
      };
      pedido.onerror = () => {
        suportado = false;
        resolve(null);
      };
      /* Modo privado do Firefox resolve nem success nem error: sem este limite a
         abertura ficaria pendente e o painel não carregaria. */
      setTimeout(() => {
        if (!conexao) {
          suportado = false;
          resolve(null);
        }
      }, 3000);
    });

    return tentativaAbertura;
  }

  function transacao(modo) {
    return abrir().then((banco) => {
      if (!banco) return null;
      try {
        return banco.transaction(LOJA_FOTOS, modo).objectStore(LOJA_FOTOS);
      } catch {
        return null;
      }
    });
  }

  function comoPromessa(pedido) {
    return new Promise((resolve, reject) => {
      pedido.onsuccess = () => resolve(pedido.result);
      pedido.onerror = () => reject(pedido.error || new Error('Falha no IndexedDB.'));
    });
  }

  /* ----------------------------------------------------- conversões base64 */

  /* Converte o data-URI que o `canvas.toDataURL()` devolve em Blob, sem passar
     por string intermediária maior que o próprio binário. */
  function dataUriParaBlob(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
    const separador = uri.indexOf(',');
    if (separador < 0) return null;
    const cabecalho = uri.slice(5, separador);
    const tipo = cabecalho.split(';')[0] || 'image/jpeg';
    const base64 = uri.slice(separador + 1);
    let binario;
    try {
      binario = global.atob(base64);
    } catch {
      return null;
    }
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
    return new global.Blob([bytes], { type: tipo });
  }

  /* Caminho inverso, usado na impressão e no fallback sem IndexedDB: o
     `window.print()` de alguns navegadores descarta object URL de outra janela,
     então o relatório impresso precisa do data-URI de verdade. */
  function blobParaDataUri(blob) {
    return new Promise((resolve, reject) => {
      if (!blob) {
        resolve('');
        return;
      }
      const leitor = new global.FileReader();
      leitor.onload = () => resolve(String(leitor.result || ''));
      leitor.onerror = () => reject(leitor.error || new Error('Falha ao ler a imagem.'));
      leitor.readAsDataURL(blob);
    });
  }

  /* --------------------------------------------------------------- escrita */

  /* Guarda os bytes como ArrayBuffer, não como Blob.

     O IndexedDB dos navegadores aceita Blob na clonagem estrutural, mas nem
     toda implementação o faz — o fake-indexeddb usado nos testes devolve um
     objeto vazio no lugar do Blob, e esse tipo de perda silenciosa de binário
     é exatamente o que não se quer descobrir em produção. ArrayBuffer clona
     igual em todo lugar; o tipo viaja no campo `tipo` e o Blob é remontado na
     leitura. */
  function guardarFoto(id, origem) {
    if (!id || !origem) return Promise.resolve(false);
    return paraArrayBuffer(origem).then((dados) => {
      if (!dados) return false;
      return transacao('readwrite').then((loja) => {
        if (!loja) return false;
        return comoPromessa(loja.put({
          id,
          dados,
          tipo: origem.type || 'image/jpeg',
          bytes: dados.byteLength,
          criadoEm: new Date().toISOString()
        })).then(() => true).catch(() => false);
      });
    }).catch(() => false);
  }

  /* Aceita Blob, ArrayBuffer ou view tipada: o painel entrega Blob vindo do
     canvas, e o sync com o R2 vai entregar buffer já lido da rede. */
  function paraArrayBuffer(origem) {
    if (origem instanceof global.ArrayBuffer) return Promise.resolve(origem);
    if (origem && origem.buffer instanceof global.ArrayBuffer) {
      return Promise.resolve(origem.buffer.slice(origem.byteOffset, origem.byteOffset + origem.byteLength));
    }
    if (origem && typeof origem.arrayBuffer === 'function') return origem.arrayBuffer();
    return Promise.resolve(null);
  }

  function removerFoto(id) {
    if (!id) return Promise.resolve(false);
    liberarUrl(id);
    return transacao('readwrite').then((loja) => {
      if (!loja) return false;
      return comoPromessa(loja.delete(id)).then(() => true).catch(() => false);
    });
  }

  /* Apaga o que não é mais referenciado pelo estado. O painel remove fotos e
     relatórios inteiros; sem esta limpeza o Blob ficaria órfão ocupando cota. */
  /* `pavimentosEmUso` é lista de ID DE PAVIMENTO, não de chave: a montagem do
     prefixo continua sendo responsabilidade exclusiva daqui.

     Ela existe porque a limpeza apagava as plantas. A loja é a mesma das
     fotografias, e tudo que não estivesse na lista de fotos em uso era tratado
     como lixo — inclusive a planta recém-baixada. No arranque, `reidratar`
     restaurava a planta e a limpeza a apagava em seguida, revogando o endereço
     da imagem: o pavimento abria com o quadro de imagem quebrada. */
  function removerOrfas(idsEmUso, pavimentosEmUso) {
    const emUso = new Set(idsEmUso || []);
    for (const pavimentoId of pavimentosEmUso || []) emUso.add(chaveDaPlanta(pavimentoId));
    return transacao('readwrite').then((loja) => {
      if (!loja) return 0;
      return comoPromessa(loja.getAllKeys()).then((chaves) => {
        const sobrando = chaves.filter((chave) => !emUso.has(chave));
        sobrando.forEach((chave) => {
          liberarUrl(chave);
          loja.delete(chave);
        });
        return sobrando.length;
      }).catch(() => 0);
    });
  }

  /* --------------------------------------------------------------- leitura */

  /* Devolve o registro cru: os bytes mais os metadados. É daqui que o upload
     para o R2 tira o Content-Type — objeto no bucket com tipo errado é servido
     como download em vez de imagem. */
  function lerRegistro(id) {
    if (!id) return Promise.resolve(null);
    return transacao('readonly').then((loja) => {
      if (!loja) return null;
      return comoPromessa(loja.get(id))
        .then((registro) => (registro && registro.dados ? registro : null))
        .catch(() => null);
    });
  }

  function lerFoto(id) {
    return lerRegistro(id).then((registro) => (
      registro ? new global.Blob([registro.dados], { type: registro.tipo || 'image/jpeg' }) : null
    ));
  }

  /* ------------------------------------------------------------ plantas */

  /* A planta de pavimento mora na mesma loja, sob a chave `planta:<pavimento>`.
     O prefixo é o que impede colisão com o id de uma fotografia.

     Estas duas não são apelidos de `guardarFoto`/`urlDaFoto`, e a diferença
     importa: a fotografia é imutável — substituir uma gera id novo —, então
     guardar o object URL em cache sob o id é sempre correto. A planta é
     SUBSTITUÍVEL no mesmo pavimento, e o cache passaria a apontar para o blob
     anterior. O resultado seria o pior tipo de erro silencioso: o engenheiro
     demarcando setor sobre o desenho antigo, sem nada na tela indicando isso.

     Por isso `guardarPlanta` libera a URL antes de gravar: a próxima leitura
     cria uma nova, já sobre o binário novo.

     O prefixo é montado AQUI e em nenhum outro lugar. Quem chama passa o id do
     pavimento; se cada chamador montasse a chave, bastaria um deles divergir
     para a planta ser gravada sob um nome e procurada sob outro — e o sintoma
     seria "a planta sumiu", sem erro nenhum apontando a causa. */
  const PREFIXO_PLANTA = 'planta:';

  function chaveDaPlanta(pavimentoId) {
    return `${PREFIXO_PLANTA}${pavimentoId}`;
  }

  function guardarPlanta(pavimentoId, origem) {
    const chave = chaveDaPlanta(pavimentoId);
    liberarUrl(chave);
    return guardarFoto(chave, origem);
  }

  function urlDaPlanta(pavimentoId) {
    return urlDaFoto(chaveDaPlanta(pavimentoId));
  }

  function registroDaPlanta(pavimentoId) {
    return lerRegistro(chaveDaPlanta(pavimentoId));
  }

  function removerPlanta(pavimentoId) {
    return removerFoto(chaveDaPlanta(pavimentoId));
  }

  /* Descarta o object URL em cache sem apagar o binário.

     Serve para quando a URL morreu — revogada, ou descartada pelo navegador sob
     pressão de memória — e é preciso gerar outra a partir do mesmo arquivo. Sem
     liberar, `urlDaPlanta` devolveria do cache exatamente a URL morta. */
  function liberarUrlDaPlanta(pavimentoId) {
    liberarUrl(chaveDaPlanta(pavimentoId));
  }

  /* Devolve um object URL estável para a foto, criando-o na primeira chamada. */
  function urlDaFoto(id) {
    if (!id) return Promise.resolve('');
    if (urlsAtivas.has(id)) return Promise.resolve(urlsAtivas.get(id));
    return lerFoto(id).then((blob) => {
      if (!blob) return '';
      const url = global.URL.createObjectURL(blob);
      urlsAtivas.set(id, url);
      return url;
    });
  }

  /* Resolve várias de uma vez: o painel renderiza galerias inteiras, e uma
     chamada por foto multiplicaria as transações sem necessidade. */
  function urlsDasFotos(ids) {
    const unicos = Array.from(new Set((ids || []).filter(Boolean)));
    return Promise.all(unicos.map((id) => urlDaFoto(id).then((url) => [id, url])))
      .then((pares) => new Map(pares));
  }

  function liberarUrl(id) {
    const url = urlsAtivas.get(id);
    if (!url) return;
    try {
      global.URL.revokeObjectURL(url);
    } catch {
      /* Navegador já descartou a URL; nada a fazer. */
    }
    urlsAtivas.delete(id);
  }

  function liberarTodasAsUrls() {
    Array.from(urlsAtivas.keys()).forEach(liberarUrl);
  }

  /* --------------------------------------------------------------- medidas */

  function ocupacao() {
    return transacao('readonly').then((loja) => {
      if (!loja) return { fotos: 0, bytes: 0 };
      return comoPromessa(loja.getAll())
        .then((registros) => ({
          fotos: registros.length,
          bytes: registros.reduce((total, registro) => total + (registro.bytes || 0), 0)
        }))
        .catch(() => ({ fotos: 0, bytes: 0 }));
    });
  }

  function disponivel() {
    if (suportado !== null) return Promise.resolve(suportado);
    return abrir().then(() => suportado === true);
  }

  global.NBZMidia = {
    abrir,
    disponivel,
    guardarFoto,
    guardarPlanta,
    urlDaPlanta,
    registroDaPlanta,
    removerPlanta,
    liberarUrlDaPlanta,
    lerFoto,
    lerRegistro,
    removerFoto,
    removerOrfas,
    urlDaFoto,
    urlsDasFotos,
    liberarUrl,
    liberarTodasAsUrls,
    ocupacao,
    dataUriParaBlob,
    blobParaDataUri
  };
})(typeof window !== 'undefined' ? window : globalThis);

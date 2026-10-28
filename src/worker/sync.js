/* Sincronizacao de obras, pavimentos, setores e relatorios.

   POR QUE EXISTE

   A foto precisa de um relatorio no D1 para se pendurar: `POST /fotos` recusa
   com 404 se `relatorios_foto` nao tiver a linha. Como o painel montava tudo no
   localStorage, nada disso existia no servidor — e sem esta ponte o upload
   falharia em toda foto.

   COMO FUNCIONA

   Duas rotas, e o painel continua sendo o dono do estado:

     POST /sync/subir   { obras: [...] }        -> grava o que mudou
     GET  /sync/baixar?desde=<iso>              -> devolve o que mudou depois

   Nao e CRDT nem merge de tres vias. A regra e ultima escrita vence por
   registro, comparando `atualizado_em`: para este uso — poucas pessoas, cada
   uma mexendo na sua obra — o conflito e raro, e resolve-lo por carimbo de
   tempo custa uma fracao do que custaria um merge de verdade.

   A excecao e a situacao dos setores, que vai para `setor_situacao_log` em
   append-only: dois engenheiros marcando o mesmo setor na mesma visita nao se
   sobrescrevem, e fica o rastro de quem mudou o que.

   O QUE ESTA ROTA NAO FAZ

   Nao apaga nada que o cliente nao tenha mandado. Um aparelho que ficou um mes
   offline e sobe um estado antigo nao pode varrer o que os outros criaram nesse
   tempo — por isso a subida e sempre upsert, e exclusao e explicita via
   `excluido_em`.
*/
import { agora, novoId } from './cripto.js';

function limpar(valor, tamanho) {
  return String(valor === undefined || valor === null ? '' : valor).trim().slice(0, tamanho);
}

function numero(valor) {
  const convertido = Number(valor);
  return Number.isFinite(convertido) ? convertido : 0;
}

function podeEscrever(sessao) {
  return Boolean(sessao) && sessao.nivelAcesso !== 'cliente';
}

/* O QUE CADA CARGO PODE GRAVAR, E NAO SO QUEM PODE SINCRONIZAR

   `podeEscrever` apenas barra o cliente. Com isso o TECNICO — que no painel so
   muda situacao de setor, registra fotografia e lanca presenca — podia criar,
   renomear e remodelar obra, pavimento e setor chamando `/sync/subir` direto. E
   o ENCARREGADO, que nao tem `works.create`, podia criar obra nova.

   Esconder botao nao e permissao: e a primeira frase do cabecalho do Worker, e
   a regra tinha ficado so na tela.

   O mapeamento espelha `roleDefinitions` do painel:

     works.create -> administrador, engenheiro            (criar obra)
     works.edit   -> administrador, engenheiro, encarregado (estrutura)
     status.edit  -> todos menos cliente                  (situacao do setor)

   Quem nao tem `works.edit` continua sincronizando: o pacote traz o estado
   inteiro, e recusar o pedido todo tiraria do tecnico a capacidade de registrar
   o que ele PODE. O que se faz e ignorar o que ele nao pode gravar. */
const CARGOS_CRIAR_OBRA = ['administrador', 'engenheiro'];
const CARGOS_ESTRUTURA = ['administrador', 'engenheiro', 'encarregado'];

function podeCriarObra(sessao) {
  return Boolean(sessao) && CARGOS_CRIAR_OBRA.includes(sessao.nivelAcesso);
}

function podeEditarEstrutura(sessao) {
  return Boolean(sessao) && CARGOS_ESTRUTURA.includes(sessao.nivelAcesso);
}

/* Quais destes ids ja existem como obra viva. Uma consulta por pedido. */
async function obrasQueExistem(env, ids) {
  if (!ids.length) return new Set();
  const marcas = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `select id from obras where excluido_em is null and id in (${marcas})`
  ).bind(...ids).all();
  return new Set((results || []).map((linha) => linha.id));
}

/* Mantem o mais recente entre o que chegou e o que esta gravado. Sem data no
   que chegou, assume-se agora: o cliente acabou de mandar. */
function maisRecente(entrada, gravado) {
  const quandoEntrada = Date.parse(entrada || '') || Date.now();
  const quandoGravado = Date.parse(gravado || '') || 0;
  return quandoEntrada >= quandoGravado;
}

/* ------------------------------------------------------------------ subir */

/* Uma instrucao por registro, todas enviadas de uma vez.

   A versao anterior lia cada registro antes de grava-lo, para decidir entre
   INSERT e UPDATE e comparar as datas. Numa obra de 100 setores isso dava ~270
   idas ao banco numa unica requisicao — lento, caro na cota de leituras do D1 e
   perto do limite de sub-requisicoes do Worker.

   Agora a decisao mora no SQL: `on conflict do update ... where excluded.
   atualizado_em >= tabela.atualizado_em`. O proprio banco aplica a regra de
   ultima-escrita-vence, sem que ninguem precise ler antes. E `batch()` manda
   tudo numa chamada so, dentro de uma transacao: ou a obra inteira entra, ou
   nada entra — nao sobra pavimento sem a obra a que pertence. */
export async function subir(env, sessao, corpo) {
  if (!podeEscrever(sessao)) {
    return { erro: 'Seu cargo não permite gravar alterações.', status: 403 };
  }

  const obras = Array.isArray(corpo && corpo.obras) ? corpo.obras : [];
  if (obras.length > 200) {
    return { erro: 'Envio grande demais. Sincronize em partes.', status: 413 };
  }

  if (!obras.length) {
    const soExclusoes = await aplicarExclusoes(env, sessao, corpo && corpo.exclusoes);
    return {
      ok: true, obras: 0, pavimentos: 0, setores: 0, relatorios: 0,
      exclusoesAplicadas: soExclusoes, em: agora()
    };
  }

  const contagem = { obras: 0, pavimentos: 0, setores: 0, relatorios: 0 };
  const instrucoes = [];

  /* Quem nao pode CRIAR obra tambem nao pode criar os filhos dela.

     Sem esta consulta, a obra nova era ignorada (certo) e o pavimento dela era
     gravado assim mesmo — e a chave estrangeira `pavimentos.obra_id` derrubava
     o lote INTEIRO. Um encarregado com obra nova no aparelho perderia toda a
     sincronizacao, inclusive o que ele podia gravar.

     Uma consulta por pedido resolve: obra que nao existe e simplesmente
     pulada. Para quem pode criar, nada disso e necessario. */
  const existentes = podeCriarObra(sessao)
    ? null
    : await obrasQueExistem(env, obras.map((obra) => limpar(obra && obra.id, 64)).filter(Boolean));

  for (const obra of obras) {
    const obraId = limpar(obra && obra.id, 64);
    if (!obraId) continue;
    if (existentes && !existentes.has(obraId)) continue;
    montarObra(env, sessao, obra, obraId, instrucoes, contagem);
  }

  if (!instrucoes.length) {
    const semUpsert = await aplicarExclusoes(env, sessao, corpo && corpo.exclusoes);
    return { ok: true, ...contagem, exclusoesAplicadas: semUpsert, em: agora() };
  }

  /* O D1 limita o tamanho do lote; fatiar mantem obras grandes funcionando sem
     que o cliente precise saber desse detalhe. */
  const TAMANHO_LOTE = 100;
  for (let inicio = 0; inicio < instrucoes.length; inicio += TAMANHO_LOTE) {
    await env.DB.batch(instrucoes.slice(inicio, inicio + TAMANHO_LOTE));
  }

  /* AS EXCLUSOES VEM DEPOIS DO UPSERT, e a ordem importa.

     O painel manda o estado dele no mesmo pedido, e esse estado pode conter o
     registro que outro aparelho acabou de apagar — ou, no caso de setor que
     continua na tela, o proprio registro que se esta apagando. Marcar antes
     seria desfeito pelo upsert logo em seguida.

     Depois do upsert, a marca e a ultima palavra do pedido. */
  const exclusoesAplicadas = await aplicarExclusoes(env, sessao, corpo && corpo.exclusoes);

  return { ok: true, ...contagem, instrucoes: instrucoes.length, exclusoesAplicadas, em: agora() };
}

/* EXCLUSAO NAO SE DESFAZ POR SINCRONIZACAO

   Os quatro upserts usam `coalesce(<tabela>.excluido_em, excluded.excluido_em)`
   em vez de aceitar o valor do cliente. Uma vez marcada, a exclusao fica.

   Sem isso, qualquer aparelho que ainda tivesse o registro no estado o
   ressuscitava ao empurrar: `paraServidor` nunca envia `excluidoEm`, entao o
   upsert gravava null por cima da marca. O administrador apagava o pavimento, o
   celular do colega sincronizava com o estado antigo e o pavimento voltava para
   todo mundo — sem ninguem conseguir entender por que.

   A guarda `atualizado_em >= atualizado_em` nao ajuda aqui, porque o painel
   carimba todo registro com a hora da SINCRONIZACAO, nao com a hora em que o
   dado mudou: o aparelho mais desatualizado sempre tem o carimbo mais novo.

   Consequencia aceita: nao ha como "desexcluir" pelo sync. Restaurar exige
   mexer no banco. E o lado certo para errar — ressurreicao espontanea de
   registro apagado e muito pior que restauracao manual rara. */

/* ------------------------------------------------------------ exclusoes */

/* Cada tipo tem a tabela que marca e os cargos que podem marcar.

   Os cargos espelham o que o painel exige para oferecer o botao: obra e
   pavimento por `works.delete`, que so administrador e engenheiro tem; setor por
   `regions.edit`, que inclui o encarregado. Conferir aqui e o que vale — o
   painel esconde botao, e esconder botao nao e permissao.

   A exclusao e LOGICA: a linha fica com `excluido_em` preenchido em vez de
   sumir. E o que permite a descida contar aos outros aparelhos que o registro
   acabou; apagar de verdade faria o registro apenas desaparecer do pacote, e
   ausencia num delta significa "nao mudou". */
const TIPOS_DE_EXCLUSAO = {
  obra: { tabela: 'obras', cargos: ['administrador', 'engenheiro'] },
  pavimento: { tabela: 'pavimentos', cargos: ['administrador', 'engenheiro'] },
  setor: { tabela: 'setores', cargos: ['administrador', 'engenheiro', 'encarregado'] }
};

/* Devolve o que de fato foi aplicado, para o painel so esquecer o que o
   servidor confirmou. Item recusado por cargo continua pendente, e nao some
   como se tivesse acontecido. */
async function aplicarExclusoes(env, sessao, pedidas) {
  const lista = Array.isArray(pedidas) ? pedidas.slice(0, 500) : [];
  if (!lista.length) return [];

  const carimbo = agora();
  const instrucoes = [];
  const aplicadas = [];

  for (const item of lista) {
    const tipo = limpar(item && item.tipo, 20);
    const id = limpar(item && item.id, 64);
    const regra = TIPOS_DE_EXCLUSAO[tipo];
    if (!regra || !id) continue;
    if (!regra.cargos.includes(sessao.nivelAcesso)) continue;

    instrucoes.push(env.DB.prepare(
      `update ${regra.tabela} set excluido_em = ?, atualizado_em = ?
        where id = ? and excluido_em is null`
    ).bind(carimbo, carimbo, id));
    aplicadas.push({ tipo, id });
  }

  if (!instrucoes.length) return [];

  const TAMANHO_LOTE = 100;
  for (let inicio = 0; inicio < instrucoes.length; inicio += TAMANHO_LOTE) {
    await env.DB.batch(instrucoes.slice(inicio, inicio + TAMANHO_LOTE));
  }
  return aplicadas;
}

const SITUACOES = ['executed', 'inProgress', 'blocked', 'pending'];

/* Monta as instrucoes de uma obra inteira: a obra, seus pavimentos, os setores
   de cada um e os relatorios. Nada e executado aqui — so enfileirado, para que
   o lote saia numa transacao so. */
function montarObra(env, sessao, obra, obraId, instrucoes, contagem) {
  const carimbo = limpar(obra.atualizadoEm, 40) || agora();
  const estrutura = podeEditarEstrutura(sessao);

  /* Sem `works.edit` nada da estrutura e gravado — nem obra, nem pavimento, nem
     os campos do setor. Resta a situacao, tratada em `montarSetor`. */
  if (!estrutura) {
    montarSomenteSituacoes(env, obra, instrucoes, contagem, carimbo);
    return;
  }

  /* Com `works.edit` e sem `works.create`, a obra pode ser ATUALIZADA e nao
     criada: o `insert` viraria cadastro novo pela porta dos fundos. O update
     sobre id inexistente simplesmente nao afeta linha nenhuma. */
  if (!podeCriarObra(sessao)) {
    instrucoes.push(env.DB.prepare(
      `update obras
          set nome = ?, cidade = ?, cliente = ?, responsavel = ?, sistema = ?,
              situacao = ?, data_inicio = ?, imagem_url = ?, atualizado_em = ?
        where id = ? and excluido_em is null and ? >= atualizado_em`
    ).bind(
      limpar(obra.nome, 120), limpar(obra.cidade, 80), limpar(obra.cliente, 120),
      limpar(obra.responsavel, 80), limpar(obra.sistema, 80) || 'A definir',
      limpar(obra.situacao, 40) || 'Em andamento', limpar(obra.dataInicio, 30) || null,
      limpar(obra.imagemUrl, 500), carimbo, obraId, carimbo
    ));
    contagem.obras += 1;
    montarFilhos(env, sessao, obra, obraId, instrucoes, contagem, carimbo);
    return;
  }

  instrucoes.push(env.DB.prepare(
    `insert into obras
       (id, nome, cidade, cliente, responsavel, sistema, situacao, data_inicio,
        imagem_url, criado_por, atualizado_em, excluido_em)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       nome = excluded.nome, cidade = excluded.cidade, cliente = excluded.cliente,
       responsavel = excluded.responsavel, sistema = excluded.sistema,
       situacao = excluded.situacao, data_inicio = excluded.data_inicio,
       imagem_url = excluded.imagem_url, atualizado_em = excluded.atualizado_em,
       excluido_em = coalesce(obras.excluido_em, excluded.excluido_em)
     where excluded.atualizado_em >= obras.atualizado_em`
  ).bind(
    obraId, limpar(obra.nome, 120), limpar(obra.cidade, 80), limpar(obra.cliente, 120),
    limpar(obra.responsavel, 80), limpar(obra.sistema, 80) || 'A definir',
    limpar(obra.situacao, 40) || 'Em andamento', limpar(obra.dataInicio, 30) || null,
    limpar(obra.imagemUrl, 500), sessao.id, carimbo,
    obra.excluidoEm ? limpar(obra.excluidoEm, 40) : null
  ));
  contagem.obras += 1;
  montarFilhos(env, sessao, obra, obraId, instrucoes, contagem, carimbo);
}

function montarFilhos(env, sessao, obra, obraId, instrucoes, contagem, carimbo) {
  /* Os ids que entram neste lote. Um relatorio cujo pavimento nao esteja aqui e
     descartado: a chave estrangeira derrubaria o lote inteiro, e perder a obra
     toda por causa de um relatorio orfao seria pior que ignora-lo. */
  const pavimentosDoLote = new Set();
  const setoresDoLote = new Set();

  const pavimentos = Array.isArray(obra.pavimentos) ? obra.pavimentos : [];
  for (const [ordem, pavimento] of pavimentos.entries()) {
    const pavimentoId = limpar(pavimento && pavimento.id, 64);
    if (!pavimentoId) continue;
    pavimentosDoLote.add(pavimentoId);
    montarPavimento(env, obraId, pavimento, pavimentoId, ordem, carimbo, instrucoes, contagem, setoresDoLote);
  }

  for (const relatorio of (Array.isArray(obra.relatorios) ? obra.relatorios : [])) {
    const relatorioId = limpar(relatorio && relatorio.id, 64);
    const pavimentoId = limpar(relatorio && relatorio.pavimentoId, 64);
    if (!relatorioId || !pavimentosDoLote.has(pavimentoId)) continue;
    montarRelatorio(env, sessao, obraId, relatorio, relatorioId, pavimentoId, carimbo, instrucoes, contagem, setoresDoLote);
  }
}

/* Caminho do cargo sem `works.edit` — hoje, o tecnico.

   Ele registra fotografia e muda a situacao do setor, e e so isso que sobe.
   Nada de criar obra, renomear pavimento ou mexer em area, material ou pontos.

   `update ... where id = ?` sobre id inexistente nao afeta linha alguma, entao
   um pacote com obra nova simplesmente nao cria nada — sem precisar consultar
   antes o que existe. */
function montarSomenteSituacoes(env, obra, instrucoes, contagem, carimbo) {
  for (const pavimento of (Array.isArray(obra.pavimentos) ? obra.pavimentos : [])) {
    for (const setor of (Array.isArray(pavimento && pavimento.setores) ? pavimento.setores : [])) {
      const setorId = limpar(setor && setor.id, 64);
      const situacao = SITUACOES.includes(setor && setor.situacao) ? setor.situacao : '';
      if (!setorId || !situacao) continue;

      instrucoes.push(env.DB.prepare(
        `update setores set situacao = ?, atualizado_em = ?
          where id = ? and excluido_em is null and ? >= atualizado_em`
      ).bind(situacao, carimbo, setorId, carimbo));
      contagem.setores += 1;
    }
  }
}

function montarPavimento(env, obraId, pavimento, pavimentoId, ordem, carimbo, instrucoes, contagem, setoresDoLote) {
  /* `planta_r2_key` fica de fora do update: quem a define e o upload da planta,
     e sobrescreve-la com o que veio do cliente apagaria a referencia do arquivo
     no bucket. */
  instrucoes.push(env.DB.prepare(
    /* OS DADOS DA PLANTA NAO ENTRAM AQUI, E ISSO E DELIBERADO

       `planta_r2_key`, `planta_largura`, `planta_altura` e `planta_arquivo`
       pertencem a `POST /plantas` e a `DELETE /plantas/:id`. Quem envia ou
       apaga a planta e quem grava esses campos — ninguem mais.

       Deixa-los no upsert do sync parecia inofensivo e nao era: a guarda
       `excluded.atualizado_em >= pavimentos.atualizado_em` nao protege nada,
       porque o painel carimba TODO registro com a hora da sincronizacao, e nao
       com a hora em que o dado mudou. "Ultima escrita vence" vira "ultimo que
       sincronizou vence", e qualquer aparelho com estado velho na memoria
       sobrescreve o servidor com carimbo novo.

       Na pratica: alguem apagava a planta, o DELETE limpava os campos, e o
       aparelho de outra pessoa — que ainda tinha o nome do arquivo na memoria —
       empurrava tudo de volta na sincronizacao seguinte. A planta ressuscitava
       sem ninguem entender por que. */
    `insert into pavimentos
       (id, obra_id, nome, area_total, ordem, atualizado_em, excluido_em)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       nome = excluded.nome, area_total = excluded.area_total, ordem = excluded.ordem,
       atualizado_em = excluded.atualizado_em,
       excluido_em = coalesce(pavimentos.excluido_em, excluded.excluido_em)
     where excluded.atualizado_em >= pavimentos.atualizado_em`
  ).bind(
    pavimentoId, obraId, limpar(pavimento.nome, 60), numero(pavimento.areaTotal), ordem,
    limpar(pavimento.atualizadoEm, 40) || carimbo,
    pavimento.excluidoEm ? limpar(pavimento.excluidoEm, 40) : null
  ));
  contagem.pavimentos += 1;

  for (const setor of (Array.isArray(pavimento.setores) ? pavimento.setores : [])) {
    const setorId = limpar(setor && setor.id, 64);
    if (!setorId) continue;
    setoresDoLote.add(setorId);
    montarSetor(env, pavimentoId, setor, setorId, carimbo, instrucoes, contagem);
  }
}

function montarSetor(env, pavimentoId, setor, setorId, carimbo, instrucoes, contagem) {
  const situacao = SITUACOES.includes(setor.situacao) ? setor.situacao : '';
  /* `pontos` vai como JSON: SQLite nao tem array, e o painel ja trata esse
     campo como bloco opaco. */
  const pontos = JSON.stringify(Array.isArray(setor.pontos) ? setor.pontos : []);

  /* O historico de situacao nao e inserido aqui: gatilhos no schema cuidam
     disso quando `situacao` muda. Assim nao e preciso ler o setor antes para
     descobrir se houve mudanca — e qualquer outro caminho que altere a tabela
     tambem deixa rastro. */
  instrucoes.push(env.DB.prepare(
    `insert into setores
       (id, pavimento_id, nome, situacao, pontos, area, data_inicio, data_fim,
        material, sistema, custo_unitario, atualizado_em, excluido_em)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       nome = excluded.nome, situacao = excluded.situacao, pontos = excluded.pontos,
       area = excluded.area, data_inicio = excluded.data_inicio,
       data_fim = excluded.data_fim, material = excluded.material,
       sistema = excluded.sistema, custo_unitario = excluded.custo_unitario,
       atualizado_em = excluded.atualizado_em, excluido_em = coalesce(setores.excluido_em, excluded.excluido_em)
     where excluded.atualizado_em >= setores.atualizado_em`
  ).bind(
    setorId, pavimentoId, limpar(setor.nome, 60), situacao, pontos, numero(setor.area),
    limpar(setor.dataInicio, 30) || null, limpar(setor.dataFim, 30) || null,
    limpar(setor.material, 80), limpar(setor.sistema, 80),
    setor.custoUnitario === undefined || setor.custoUnitario === null ? null : numero(setor.custoUnitario),
    limpar(setor.atualizadoEm, 40) || carimbo,
    setor.excluidoEm ? limpar(setor.excluidoEm, 40) : null
  ));
  contagem.setores += 1;
}

function montarRelatorio(env, sessao, obraId, relatorio, relatorioId, pavimentoId, carimbo, instrucoes, contagem, setoresDoLote) {
  const setorId = limpar(relatorio.setorId, 64);
  const origem = relatorio.origem === 'local' ? 'local' : 'relatorio';

  instrucoes.push(env.DB.prepare(
    `insert into relatorios_foto
       (id, obra_id, pavimento_id, setor_id, origem, descricao, data, autor_id,
        atualizado_em, excluido_em)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       pavimento_id = excluded.pavimento_id, setor_id = excluded.setor_id,
       origem = excluded.origem, descricao = excluded.descricao, data = excluded.data,
       atualizado_em = excluded.atualizado_em, excluido_em = coalesce(relatorios_foto.excluido_em, excluded.excluido_em)
     where excluded.atualizado_em >= relatorios_foto.atualizado_em`
  ).bind(
    relatorioId, obraId, pavimentoId,
    setoresDoLote.has(setorId) ? setorId : null,
    origem, limpar(relatorio.descricao, 220), limpar(relatorio.data, 40) || carimbo,
    sessao.id, limpar(relatorio.atualizadoEm, 40) || carimbo,
    relatorio.excluidoEm ? limpar(relatorio.excluidoEm, 40) : null
  ));
  contagem.relatorios += 1;
}

/* ----------------------------------------------------------------- baixar */

/* Devolve o que mudou depois de `desde`. Sem `desde`, devolve tudo — primeira
   abertura num aparelho novo.

   Inclui o que foi excluido (com `excluidoEm` preenchido), porque e assim que a
   exclusao feita num aparelho chega aos outros. Filtrar os excluidos faria a
   foto apagada reaparecer na proxima sincronizacao. */
export async function baixar(env, sessao, parametros) {
  const desde = String(parametros.get('desde') || '').trim();
  const corte = desde && Number.isFinite(Date.parse(desde)) ? desde : '1970-01-01T00:00:00.000Z';

  const obras = await consultar(env,
    `select * from obras where atualizado_em > ? order by atualizado_em limit 500`, [corte]);
  const pavimentos = await consultar(env,
    `select * from pavimentos where atualizado_em > ? order by atualizado_em limit 2000`, [corte]);
  const setores = await consultar(env,
    `select * from setores where atualizado_em > ? order by atualizado_em limit 5000`, [corte]);
  const relatorios = await consultar(env,
    `select * from relatorios_foto where atualizado_em > ? order by atualizado_em limit 2000`, [corte]);
  const fotos = await consultar(env,
    `select id, relatorio_id, bytes, largura, altura, legenda, incluir_laudo, data,
            autor_id, atualizado_em, excluido_em
       from fotos where atualizado_em > ? order by atualizado_em limit 5000`, [corte]);

  return {
    em: agora(),
    obras: obras.map((linha) => ({
      id: linha.id, nome: linha.nome, cidade: linha.cidade, cliente: linha.cliente,
      responsavel: linha.responsavel, sistema: linha.sistema, situacao: linha.situacao,
      dataInicio: linha.data_inicio, imagemUrl: linha.imagem_url,
      atualizadoEm: linha.atualizado_em, excluidoEm: linha.excluido_em
    })),
    pavimentos: pavimentos.map((linha) => ({
      id: linha.id, obraId: linha.obra_id, nome: linha.nome, areaTotal: linha.area_total,
      ordem: linha.ordem, temPlanta: Boolean(linha.planta_r2_key),
      plantaLargura: linha.planta_largura, plantaAltura: linha.planta_altura,
      plantaArquivo: linha.planta_arquivo,
      atualizadoEm: linha.atualizado_em, excluidoEm: linha.excluido_em
    })),
    setores: setores.map((linha) => ({
      id: linha.id, pavimentoId: linha.pavimento_id, nome: linha.nome, situacao: linha.situacao,
      pontos: lerJson(linha.pontos), area: linha.area, dataInicio: linha.data_inicio,
      dataFim: linha.data_fim, material: linha.material, sistema: linha.sistema,
      custoUnitario: linha.custo_unitario,
      atualizadoEm: linha.atualizado_em, excluidoEm: linha.excluido_em
    })),
    relatorios: relatorios.map((linha) => ({
      id: linha.id, obraId: linha.obra_id, pavimentoId: linha.pavimento_id,
      setorId: linha.setor_id, origem: linha.origem, descricao: linha.descricao,
      data: linha.data, autorId: linha.autor_id,
      atualizadoEm: linha.atualizado_em, excluidoEm: linha.excluido_em
    })),
    fotos: fotos.map((linha) => ({
      id: linha.id, relatorioId: linha.relatorio_id, bytes: linha.bytes,
      largura: linha.largura, altura: linha.altura, legenda: linha.legenda,
      incluirLaudo: linha.incluir_laudo === 1, data: linha.data, autorId: linha.autor_id,
      atualizadoEm: linha.atualizado_em, excluidoEm: linha.excluido_em
    }))
  };
}

async function consultar(env, sql, args) {
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results || [];
}

function lerJson(texto) {
  try {
    const valor = JSON.parse(texto);
    return Array.isArray(valor) ? valor : [];
  } catch {
    return [];
  }
}

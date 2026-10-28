/* Ponte entre o estado do painel e o formato do servidor.

   O painel guarda `projects[]` com `floorPlans[]` e `photoReports[]`; o servidor
   guarda `obras` com `pavimentos`, `setores` e `relatorios_foto`. Sao a mesma
   coisa com nomes diferentes, e a traducao mora aqui — num lugar so, para que
   nem o index.html precise conhecer o vocabulario do servidor nem o Worker
   precise conhecer o do painel.

   ORDEM IMPORTA

   Subir vem antes de enviar foto, e nao por organizacao: `POST /fotos` recusa
   com 404 se o relatorio nao existir no D1. Enquanto a obra, o pavimento e o
   relatorio nao subirem, nao ha onde pendurar a imagem.

   O QUE ESTA CAMADA NAO FAZ

   Nao decide quando sincronizar — quem chama e o painel, depois de gravar. E
   nao resolve conflito: isso e do servidor, por `atualizado_em`.
*/
(function (global) {
  'use strict';

  /* O painel nao carimba data de alteracao por registro; usa-se a hora da
     sincronizacao. Para ultima-escrita-vence isso basta: o que acabou de sair
     deste aparelho e, de fato, o mais recente que ele conhece. */
  function agora() {
    return new Date().toISOString();
  }

  /* ------------------------------------------------- painel -> servidor */

  function obraDoProjeto(projeto, carimbo) {
    const pavimentos = (projeto.floorPlans || []).map((pavimento) => ({
      id: pavimento.id,
      nome: pavimento.name || '',
      areaTotal: Number(pavimento.area) || 0,
      plantaLargura: Number(pavimento.planWidth) || 0,
      plantaAltura: Number(pavimento.planHeight) || 0,
      plantaArquivo: pavimento.planFileName || '',
      atualizadoEm: carimbo,
      setores: (pavimento.regions || []).map((setor) => ({
        id: setor.id,
        nome: setor.name || '',
        /* As quatro situacoes viajam com o nome do painel: 'executed',
           'inProgress', 'blocked', 'pending'. Traduzir aqui criaria um segundo
           vocabulario, e o CHECK do schema recusaria o que divergisse. */
        situacao: setor.status || '',
        pontos: Array.isArray(setor.points) ? setor.points : [],
        area: Number(setor.area) || 0,
        dataInicio: setor.startDate || '',
        dataFim: setor.endDate || '',
        material: setor.material || '',
        sistema: setor.system || '',
        custoUnitario: setor.unitCost === undefined ? null : setor.unitCost,
        atualizadoEm: carimbo
      }))
    }));

    /* Os relatorios ficam fora do pavimento porque no painel eles moram na
       obra (`photoReports`), com `floorId` apontando para o pavimento. */
    const relatorios = (projeto.photoReports || []).map((relatorio) => ({
      id: relatorio.id,
      pavimentoId: relatorio.floorId || '',
      setorId: relatorio.regionId || '',
      origem: relatorio.source === 'local' ? 'local' : 'relatorio',
      descricao: relatorio.description || '',
      data: relatorio.date || carimbo,
      atualizadoEm: carimbo
    })).filter((relatorio) => relatorio.pavimentoId);

    return {
      id: projeto.id,
      nome: projeto.name || '',
      cidade: projeto.city || '',
      cliente: projeto.client || '',
      responsavel: projeto.manager || '',
      sistema: projeto.system || '',
      situacao: projeto.status || '',
      dataInicio: projeto.date || '',
      imagemUrl: projeto.image || '',
      atualizadoEm: carimbo,
      pavimentos,
      relatorios
    };
  }

  function paraServidor(projetos) {
    const carimbo = agora();
    return (projetos || []).filter((projeto) => projeto && projeto.id)
      .map((projeto) => obraDoProjeto(projeto, carimbo));
  }

  /* --------------------------------------------- fotos pendentes de envio */

  /* Lista as fotos do estado que ainda nao subiram, com o relatorio de cada
     uma. O painel usa isto para encher a fila depois que a obra sobe. */
  function fotosParaEnviar(projetos, jaEnviadas) {
    const enviadas = jaEnviadas instanceof Set ? jaEnviadas : new Set(jaEnviadas || []);
    const pendentes = [];
    for (const projeto of projetos || []) {
      for (const relatorio of projeto.photoReports || []) {
        for (const foto of relatorio.photos || []) {
          if (!foto || !foto.id || enviadas.has(foto.id)) continue;
          pendentes.push({ fotoId: foto.id, relatorioId: relatorio.id, legenda: relatorio.description || '' });
        }
      }
    }
    return pendentes;
  }

  /* ------------------------------------------------- servidor -> painel */

  /* Monta `projects[]` a partir do pacote do servidor. Usado no aparelho que
     ainda nao conhece a obra — e o que faz a foto de um aparecer no outro.

     Fotos entram sem `data`: o binario vem depois, por `NBZApi.baixarFoto`, e
     `reidratarFotos()` do painel preenche a URL. Baixar tudo de uma vez travaria
     a abertura em obra grande. */
  function paraPainel(pacote) {
    if (!pacote) return [];

    const porObra = new Map();
    for (const obra of pacote.obras || []) {
      if (obra.excluidoEm) continue;
      porObra.set(obra.id, {
        id: obra.id, name: obra.nome, city: obra.cidade, client: obra.cliente,
        manager: obra.responsavel, system: obra.sistema, status: obra.situacao,
        date: obra.dataInicio || '', image: obra.imagemUrl || '',
        area: 0, executed: 0, inProgress: 0, pending: 0, blocked: 0, unclassified: 0, floors: 0,
        floorPlans: [], photoReports: []
      });
    }

    const pavimentosPorId = new Map();
    for (const pavimento of pacote.pavimentos || []) {
      if (pavimento.excluidoEm) continue;
      const obra = porObra.get(pavimento.obraId);
      if (!obra) continue;
      const convertido = {
        id: pavimento.id, name: pavimento.nome, area: pavimento.areaTotal,
        regions: [], planImage: '', planWidth: pavimento.plantaLargura,
        planHeight: pavimento.plantaAltura, planFileName: pavimento.plantaArquivo || '',
        /* Diz que existe planta NO SERVIDOR para este pavimento. `planImage`
           vazio sozinho não distingue "o servidor não tem planta" de "tem, mas
           este aparelho ainda não baixou" — e é essa diferença que faz o painel
           saber se vale a pena pedir o arquivo. */
        temPlanta: Boolean(pavimento.temPlanta)
      };
      pavimentosPorId.set(pavimento.id, convertido);
      obra.floorPlans.push(convertido);
    }

    for (const setor of pacote.setores || []) {
      if (setor.excluidoEm) continue;
      const pavimento = pavimentosPorId.get(setor.pavimentoId);
      if (!pavimento) continue;
      pavimento.regions.push({
        id: setor.id, name: setor.nome, status: setor.situacao,
        points: setor.pontos || [], area: setor.area,
        startDate: setor.dataInicio || '', endDate: setor.dataFim || '',
        material: setor.material || '', system: setor.sistema || '',
        unitCost: setor.custoUnitario === null ? undefined : setor.custoUnitario
      });
    }

    const relatoriosPorId = new Map();
    for (const relatorio of pacote.relatorios || []) {
      if (relatorio.excluidoEm) continue;
      const obra = porObra.get(relatorio.obraId);
      const pavimento = pavimentosPorId.get(relatorio.pavimentoId);
      if (!obra || !pavimento) continue;
      const convertido = {
        id: relatorio.id,
        floorIndex: obra.floorPlans.indexOf(pavimento),
        floorId: relatorio.pavimentoId,
        floorName: pavimento.name,
        regionId: relatorio.setorId || '',
        source: relatorio.origem === 'local' ? 'local' : undefined,
        description: relatorio.descricao, date: relatorio.data,
        author: '', photos: []
      };
      relatoriosPorId.set(relatorio.id, convertido);
      obra.photoReports.push(convertido);
    }

    for (const foto of pacote.fotos || []) {
      if (foto.excluidoEm) continue;
      const relatorio = relatoriosPorId.get(foto.relatorioId);
      if (!relatorio) continue;
      relatorio.photos.push({
        id: foto.id, data: '', date: foto.data, author: '',
        includeInReport: foto.incluirLaudo !== false
      });
    }

    for (const obra of porObra.values()) obra.floors = obra.floorPlans.length;
    return Array.from(porObra.values());
  }

  /* Funde o que veio do servidor no estado local, por id. O servidor manda so o
     que mudou, entao o que ele nao citou permanece como esta. */
  /* AUSÊNCIA NUM PACOTE DELTA NÃO É EXCLUSÃO

     Esta é a regra que a versão anterior violava, e o estrago era total.

     O `/sync/baixar` entrega só o que mudou depois de uma marca. Se alguém mexe
     numa obra e não nos pavimentos dela, o pacote traz a obra e nenhum
     pavimento — e `paraPainel` monta o projeto com `floorPlans: []`, porque ele
     só conhece o que veio. Substituir o projeto local por essa versão apagava
     todos os pavimentos, setores e relatórios do aparelho.

     Exclusão de verdade é sinalizada por `excluidoEm`, e `paraPainel` já
     descarta essas linhas. Então o que não veio no pacote é o que NÃO MUDOU, e
     tem de ser mantido.

     Por isso a fusão é por id em cada nível: obra, pavimento, setor, relatório
     e foto. Em cada um deles, quem veio do servidor ganha dos campos locais, e
     quem é só local permanece. */
  /* O QUE O PACOTE DIZ TER SIDO EXCLUÍDO

     `paraPainel` descarta as linhas com `excluidoEm` ao montar os projetos — e
     precisa descartar, senão o registro apagado voltaria para a tela. Só que,
     depois disso, a exclusão fica indistinguível de "não veio neste delta", e a
     fusão preserva o que não veio. Resultado: exclusão nenhuma chegava ao
     painel, e o pavimento apagado ressurgia na sincronização seguinte.

     Esta função lê o mesmo pacote e separa justamente o que foi descartado, para
     a fusão poder remover. Sem ela, "ausência significa não mudou" — regra
     correta para delta — apagaria o efeito de toda exclusão. */
  function exclusoesDoPacote(pacote) {
    const vazio = { obras: new Set(), pavimentos: new Set(), setores: new Set(), relatorios: new Set(), fotos: new Set() };
    if (!pacote) return vazio;
    const colher = (lista) => new Set(
      (lista || []).filter((item) => item && item.excluidoEm).map((item) => item.id)
    );
    return {
      obras: colher(pacote.obras),
      pavimentos: colher(pacote.pavimentos),
      setores: colher(pacote.setores),
      relatorios: colher(pacote.relatorios),
      fotos: colher(pacote.fotos)
    };
  }

  function mesclarPorId(locais, vindos, combinar) {
    const porId = new Map((locais || []).map((item) => [item.id, item]));
    for (const vindo of vindos || []) {
      const local = porId.get(vindo.id);
      porId.set(vindo.id, local && combinar ? combinar(local, vindo) : vindo);
    }
    return Array.from(porId.values());
  }

  /* PRESERVAR A PLANTA LOCAL, MENOS QUANDO ELA FOI APAGADA

     O pacote traz sempre `planImage: ''` — o binário não viaja no JSON. Por isso
     a cópia local tem de ser preservada, senão cada sincronização apagaria o
     desenho do aparelho.

     Mas preservar sempre impede a exclusão de propagar: quem apaga a planta num
     aparelho a vê voltar nos outros, porque lá a cópia local sobrevive a toda
     sincronização. Foi o que aconteceu assim que a preservação entrou.

     Os dois casos têm `temPlanta` falso e são distinguidos pela FILA DE ENVIO
     deste aparelho:

       apagada no servidor      -> não está na fila: ninguém aqui pretende
                                   enviá-la, então a cópia local é resto
       importada e não enviada  -> está na fila, esperando conexão

     O nome do arquivo não serve como sinal: os dados da planta passaram a ser
     escritos apenas pelas rotas de planta, justamente porque o `/sync/subir`
     os ressuscitava. Hoje ele vem vazio nos dois casos.

     Sem `plantaPendente` informado, preserva — é o comportamento seguro para
     quem chama a função sem conhecer a fila, como os testes da tradução. */
  function mesclarPavimento(local, vindo, plantaPendente) {
    const pendente = typeof plantaPendente === 'function'
      ? Boolean(plantaPendente(vindo.id))
      : true;
    const apagadaNoServidor = vindo.temPlanta === false && !pendente;
    return {
      ...vindo,
      planImage: apagadaNoServidor ? '' : (vindo.planImage || local.planImage || ''),
      regions: mesclarPorId(local.regions, vindo.regions)
    };
  }

  function mesclarRelatorio(local, vindo) {
    return {
      ...vindo,
      photos: mesclarPorId(local.photos, vindo.photos, (fotoLocal, fotoVinda) => ({
        ...fotoVinda,
        /* Mesma razão das plantas: o binário fica no aparelho, não no pacote.
           Sobrescrever com vazio forçaria baixar tudo de novo. */
        data: fotoVinda.data || fotoLocal.data || ''
      }))
    };
  }

  /* `opcoes.plantaPendente(pavimentoId)` diz se a planta daquele pavimento está
     na fila de envio deste aparelho. Quem chama é o painel, que conhece a fila;
     a tradução em si continua sem depender dela. */
  function semOsExcluidos(lista, excluidos) {
    if (!excluidos || !excluidos.size) return lista || [];
    return (lista || []).filter((item) => !excluidos.has(item.id));
  }

  function fundir(projetosLocais, projetosDoServidor, opcoes = {}) {
    const plantaPendente = opcoes && opcoes.plantaPendente;
    /* `exclusoes` vem de `exclusoesDoPacote`. Sem ela a fusão só sabe somar, e
       exclusão feita noutro aparelho nunca chega — o registro apagado volta na
       descida seguinte porque "não veio" é lido como "não mudou". */
    const exc = (opcoes && opcoes.exclusoes) || {};

    const fundidos = mesclarPorId(projetosLocais, projetosDoServidor, (local, vindo) => ({
      ...vindo,
      floorPlans: semOsExcluidos(
        mesclarPorId(
          local.floorPlans, vindo.floorPlans,
          (pavLocal, pavVindo) => mesclarPavimento(pavLocal, pavVindo, plantaPendente)
        ),
        exc.pavimentos
      ).map((pavimento) => ({
        ...pavimento,
        regions: semOsExcluidos(pavimento.regions, exc.setores)
      })),
      photoReports: semOsExcluidos(
        mesclarPorId(local.photoReports, vindo.photoReports, mesclarRelatorio),
        exc.relatorios
      ).map((relatorio) => ({
        ...relatorio,
        photos: semOsExcluidos(relatorio.photos, exc.fotos)
      }))
    }));

    /* Obra excluída sai inteira, inclusive se o pacote não a trouxe por já estar
       fora do recorte: o id basta. */
    return semOsExcluidos(fundidos, exc.obras).map(realinharRelatorios);
  }

  /* RECALCULA `floorIndex` DEPOIS DA FUSÃO — e isto corrige corrupção de laudo.

     O painel localiza o relatório fotográfico pela POSIÇÃO do pavimento no
     array (`floorIndex`), e `paraPainel` calcula essa posição no array do
     PACOTE. A fusão monta outro array, unindo o que é local com o que veio, e
     numa descida parcial as posições não coincidem.

     Na prática: o aparelho tem [Térreo, Térreo2]; o delta traz só o Térreo2 e o
     relatório dele recebe índice 0; depois da fusão, índice 0 é o Térreo. O
     relatório fotográfico passa a pertencer ao pavimento errado — e é ele que
     alimenta o laudo.

     `floorId` é a referência confiável e já viaja junto. Recalcular a posição a
     partir dele, com o array final em mãos, é o que mantém as duas visões
     coerentes. Relatório cujo pavimento não existe mais sai: depois da fusão o
     array tem a união de tudo que existe, então ausência aqui é exclusão. */
  function realinharRelatorios(obra) {
    const posicaoPorId = new Map((obra.floorPlans || []).map((pavimento, indice) => [pavimento.id, indice]));
    return {
      ...obra,
      photoReports: (obra.photoReports || [])
        .filter((relatorio) => !relatorio.floorId || posicaoPorId.has(relatorio.floorId))
        .map((relatorio) => (relatorio.floorId
          ? { ...relatorio, floorIndex: posicaoPorId.get(relatorio.floorId) }
          : relatorio))
    };
  }

  global.NBZSync = { paraServidor, paraPainel, fundir, exclusoesDoPacote, fotosParaEnviar };
})(typeof window !== 'undefined' ? window : globalThis);

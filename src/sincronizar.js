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
  function fundir(projetosLocais, projetosDoServidor) {
    const porId = new Map((projetosLocais || []).map((projeto) => [projeto.id, projeto]));
    for (const vindo of projetosDoServidor || []) {
      const local = porId.get(vindo.id);
      if (!local) {
        porId.set(vindo.id, vindo);
        continue;
      }
      /* Preserva as fotos que ja tem binario local: o pacote do servidor traz
         `data: ''`, e sobrescrever cegamente apagaria a imagem que o aparelho
         ja possui, forcando baixar tudo de novo. */
      const dadosLocais = new Map();
      for (const relatorio of local.photoReports || []) {
        for (const foto of relatorio.photos || []) {
          if (foto.data) dadosLocais.set(foto.id, foto.data);
        }
      }
      for (const relatorio of vindo.photoReports || []) {
        for (const foto of relatorio.photos || []) {
          if (!foto.data && dadosLocais.has(foto.id)) foto.data = dadosLocais.get(foto.id);
        }
      }

      /* A planta precisa da mesma proteção, e por um motivo mais agudo que o das
         fotos: o pacote do servidor sempre traz `planImage: ''`, então sem isto
         CADA sincronização apagaria a planta que o aparelho já tem. O pavimento
         voltaria a abrir sem desenho, com os setores demarcados flutuando — e o
         engenheiro veria a planta sumir sozinha no meio da visita. */
      const plantasLocais = new Map();
      for (const pavimento of local.floorPlans || []) {
        if (pavimento.planImage) plantasLocais.set(pavimento.id, pavimento.planImage);
      }
      for (const pavimento of vindo.floorPlans || []) {
        if (!pavimento.planImage && plantasLocais.has(pavimento.id)) {
          pavimento.planImage = plantasLocais.get(pavimento.id);
        }
      }

      porId.set(vindo.id, vindo);
    }
    return Array.from(porId.values());
  }

  global.NBZSync = { paraServidor, paraPainel, fundir, fotosParaEnviar };
})(typeof window !== 'undefined' ? window : globalThis);

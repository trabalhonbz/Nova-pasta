/* Testes da retencao de fotografias e do teto de cota do R2.

   Rode com `npm run test:retencao`.

   A regra sob teste: cada obra guarda as quatro semanas mais recentes de
   relatorio; a chegada da quinta apaga a primeira. O que se verifica aqui e o
   que mais dolorido seria descobrir em producao — que a janela conta por obra,
   que o binario sai do bucket, que a linha fica no D1 marcada para a
   sincronizacao levar a exclusao aos aparelhos, e que o contador de bytes nao
   dobra quando a fila offline reenvia a mesma foto.

   O D1 aqui e `node:sqlite` com o schema de verdade, entao o `strftime('%Y-W%W')`
   que agrupa as semanas e o mesmo que roda na nuvem. O R2 e um Map: o que
   importa testar nele e que as chaves certas sao apagadas.
*/
import { adaptarD1, bancoNovo } from './d1-memoria.mjs';
import { teste, confirmar, igual, executar } from './harness.js';
import * as fotos from '../src/worker/fotos.js';
import {
  SEMANAS_GUARDADAS, TETO_BYTES, aplicarRetencao, cabeNaCota, recalcularUso,
  relatorioDeUso, semanasVencidas, somarUso, usoRegistrado
} from '../src/worker/retencao.js';

/* Seis segundas-feiras seguidas. O espacamento de sete dias e o que importa:
   `%W` avanca exatamente uma semana a cada sete dias, independente de qual dia
   da semana a data caia. */
const SEMANAS = [
  '2026-09-07T08:00:00.000Z',
  '2026-09-14T08:00:00.000Z',
  '2026-09-21T08:00:00.000Z',
  '2026-09-28T08:00:00.000Z',
  '2026-10-05T08:00:00.000Z',
  '2026-10-12T08:00:00.000Z'
];

/* Bucket falso. `delete` aceita chave ou lista, como o R2 de verdade. */
function bucketFalso() {
  const objetos = new Map();
  return {
    objetos,
    put(chave, bytes) { objetos.set(chave, bytes); return Promise.resolve(); },
    get(chave) { return Promise.resolve(objetos.get(chave) || null); },
    delete(chaves) {
      for (const chave of [].concat(chaves)) objetos.delete(chave);
      return Promise.resolve();
    }
  };
}

function montarAmbiente({ comR2 = true } = {}) {
  const db = bancoNovo();
  const env = {
    DB: adaptarD1(db),
    PEPPER: 'pepper-de-teste-nao-usar-em-producao',
    ORIGENS: ''
  };
  if (comR2) env.FOTOS = bucketFalso();
  return { db, env };
}

/* Monta uma obra com um pavimento e um relatorio por semana, cada relatorio com
   `fotosPorSemana` fotografias de `bytes` cada. Devolve o que os testes precisam
   para conferir depois. */
function semearObra(db, { obra, semanas, fotosPorSemana = 2, bytes = 250000 }) {
  db.prepare('insert into obras (id, nome) values (?, ?)').run(obra, `Obra ${obra}`);
  db.prepare('insert into pavimentos (id, obra_id, nome) values (?, ?, ?)')
    .run(`${obra}-pav`, obra, 'Terreo');

  const criadas = [];
  semanas.forEach((data, indice) => {
    const relatorio = `${obra}-rel-${indice + 1}`;
    db.prepare(
      'insert into relatorios_foto (id, obra_id, pavimento_id, data) values (?, ?, ?, ?)'
    ).run(relatorio, obra, `${obra}-pav`, data);

    for (let n = 0; n < fotosPorSemana; n += 1) {
      const id = `${relatorio}-foto-${n + 1}`;
      const chave = `obras/${obra}/${relatorio}/${id}.jpg`;
      db.prepare(
        'insert into fotos (id, relatorio_id, r2_key, bytes, data) values (?, ?, ?, ?, ?)'
      ).run(id, relatorio, chave, bytes, data);
      criadas.push({ id, chave, relatorio, semana: indice + 1 });
    }
  });
  return criadas;
}

/* Preenche o bucket com as chaves semeadas no banco, para que o teste possa
   conferir que a retencao tirou de la exatamente as que deviam sair. */
function encherBucket(env, criadas) {
  for (const foto of criadas) env.FOTOS.objetos.set(foto.chave, new Uint8Array(8));
}

function vivas(db) {
  return db.prepare('select id from fotos where excluido_em is null order by id').all()
    .map((linha) => linha.id);
}

function semanasVivas(db) {
  return db.prepare(
    "select distinct strftime('%Y-W%W', r.data) as semana"
    + ' from fotos f join relatorios_foto r on r.id = f.relatorio_id'
    + ' where f.excluido_em is null order by semana'
  ).all().map((linha) => linha.semana);
}

/* ------------------------------------------------------------ a janela */

teste('a janela e de quatro semanas: com seis, as duas mais antigas saem', async () => {
  const { db, env } = montarAmbiente();
  const criadas = semearObra(db, { obra: 'A', semanas: SEMANAS });
  encherBucket(env, criadas);

  const resumo = await aplicarRetencao(env);

  confirmar(resumo.executada, 'a retencao devia ter rodado com o R2 ativo');
  igual(semanasVivas(db).length, SEMANAS_GUARDADAS, 'deviam sobrar quatro semanas');
  igual(resumo.semanas, 2, 'duas semanas deviam ter vencido');
  igual(resumo.fotos, 4, 'duas semanas de duas fotos cada');

  /* As que ficam sao as quatro MAIS RECENTES, nao quaisquer quatro. */
  const sobreviventes = vivas(db);
  for (const foto of criadas) {
    const deviaFicar = foto.semana > 2;
    igual(
      sobreviventes.includes(foto.id), deviaFicar,
      `foto da semana ${foto.semana} (${foto.id})`
    );
  }
});

teste('o binario sai do bucket, e so o das semanas vencidas', async () => {
  const { db, env } = montarAmbiente();
  const criadas = semearObra(db, { obra: 'A', semanas: SEMANAS });
  encherBucket(env, criadas);

  await aplicarRetencao(env);

  for (const foto of criadas) {
    const deviaFicar = foto.semana > 2;
    igual(
      env.FOTOS.objetos.has(foto.chave), deviaFicar,
      `objeto no R2 da semana ${foto.semana}`
    );
  }
});

teste('a exclusao e logica, para a sincronizacao levar a baixa aos aparelhos', async () => {
  const { db, env } = montarAmbiente();
  encherBucket(env, semearObra(db, { obra: 'A', semanas: SEMANAS }));

  await aplicarRetencao(env);

  /* A linha continua na tabela: e ela que `/sync/baixar` manda com `excluidoEm`
     para o celular largar a copia no IndexedDB. Apagar a linha de verdade
     deixaria o aparelho exibindo foto que o servidor nao tem mais. */
  const apagadas = db.prepare(
    'select id, excluido_em, atualizado_em from fotos where excluido_em is not null'
  ).all();
  igual(apagadas.length, 4, 'as quatro fotos vencidas deviam continuar na tabela');
  for (const linha of apagadas) {
    confirmar(linha.excluido_em, `${linha.id} sem excluido_em`);
    /* `atualizado_em` tem de avancar junto, senao o sync nao ve a mudanca. */
    igual(linha.atualizado_em, linha.excluido_em, `${linha.id}: carimbos divergentes`);
  }
});

teste('a janela conta por obra: obra nova nao e apagada por obra movimentada', async () => {
  const { db, env } = montarAmbiente();
  const obraA = semearObra(db, { obra: 'A', semanas: SEMANAS });
  const obraB = semearObra(db, { obra: 'B', semanas: SEMANAS.slice(0, 2) });
  encherBucket(env, obraA.concat(obraB));

  await aplicarRetencao(env);

  /* A obra B tem duas semanas, dentro da janela: nada dela pode sair, mesmo que
     a obra A tenha seis e mesmo que as semanas de B sejam as mais antigas de
     todas. Numa janela global, as duas semanas de B seriam as primeiras a cair. */
  const sobreviventes = vivas(db);
  for (const foto of obraB) {
    confirmar(sobreviventes.includes(foto.id), `obra B perdeu ${foto.id}`);
  }
  igual(
    obraA.filter((foto) => sobreviventes.includes(foto.id)).length, 8,
    'obra A devia ficar com quatro semanas de duas fotos'
  );
});

teste('rodar duas vezes nao apaga nada a mais', async () => {
  const { db, env } = montarAmbiente();
  encherBucket(env, semearObra(db, { obra: 'A', semanas: SEMANAS }));

  await aplicarRetencao(env);
  const depoisDaPrimeira = vivas(db);
  const segunda = await aplicarRetencao(env);

  igual(segunda.fotos, 0, 'a segunda passagem nao tinha o que apagar');
  igual(vivas(db), depoisDaPrimeira, 'a segunda passagem mexeu no que ja estava certo');
});

teste('sem R2 ativo a retencao nao roda, para nao perder registro de graca', async () => {
  const { db, env } = montarAmbiente({ comR2: false });
  const criadas = semearObra(db, { obra: 'A', semanas: SEMANAS });

  const resumo = await aplicarRetencao(env);

  confirmar(!resumo.executada, 'nao devia executar sem bucket');
  igual(
    vivas(db).length, criadas.length,
    'marcar linha sem liberar byte nenhum seria perda pura'
  );
});

teste('semanasVencidas: a janela e configuravel e conta da mais recente', () => {
  /* A consulta entrega as semanas em ordem decrescente dentro de cada obra; esta
     e a funcao que decide quais passaram da janela, isolada do banco. */
  const linhas = [
    { obra: 'A', semana: '2026-W41' },
    { obra: 'A', semana: '2026-W40' },
    { obra: 'A', semana: '2026-W39' },
    { obra: 'B', semana: '2026-W41' }
  ];
  igual(semanasVencidas(linhas, 2).map((l) => `${l.obra}/${l.semana}`), ['A/2026-W39']);
  igual(semanasVencidas(linhas, 4), [], 'com janela de quatro nada vence');
});

/* --------------------------------------------------------- teto de cota */

teste('o contador soma, desconta e nunca fica negativo', async () => {
  const { env } = montarAmbiente();

  igual(await usoRegistrado(env), 0, 'comeca em zero');
  await somarUso(env, 1000);
  await somarUso(env, 500);
  igual(await usoRegistrado(env), 1500, 'depois de somar');
  await somarUso(env, -400);
  igual(await usoRegistrado(env), 1100, 'depois de descontar');

  /* Desvio acumulado nao pode deixar o contador negativo: com valor negativo o
     teto pararia de valer e a cota estouraria sem aviso. */
  await somarUso(env, -999999);
  igual(await usoRegistrado(env), 0, 'piso em zero');
});

teste('o recalculo corrige o desvio a partir da tabela', async () => {
  const { db, env } = montarAmbiente();
  semearObra(db, { obra: 'A', semanas: SEMANAS.slice(0, 2), fotosPorSemana: 2, bytes: 1000 });

  await somarUso(env, 777777);
  const total = await recalcularUso(env);

  igual(total, 4000, 'quatro fotos de mil bytes');
  igual(await usoRegistrado(env), 4000, 'o contador ficou com a verdade da tabela');
});

teste('o recalculo ignora o que foi apagado', async () => {
  const { db, env } = montarAmbiente();
  encherBucket(env, semearObra(db, { obra: 'A', semanas: SEMANAS, bytes: 1000 }));

  await aplicarRetencao(env);

  /* Oito fotos vivas de mil bytes; as quatro vencidas nao contam mais. */
  igual(await recalcularUso(env), 8000, 'o apagado nao conta na cota');
});

teste('cabeNaCota recusa o que passaria do teto de 9,5 GB', async () => {
  const { env } = montarAmbiente();

  confirmar(await cabeNaCota(env, 1024), 'com o banco vazio tem de caber');

  await somarUso(env, TETO_BYTES - 100);
  confirmar(await cabeNaCota(env, 100), 'exatamente no teto ainda cabe');
  confirmar(!(await cabeNaCota(env, 101)), 'um byte acima do teto nao cabe');
});

teste('o medidor relata uso, teto e porcentagem', async () => {
  const { db, env } = montarAmbiente();
  semearObra(db, { obra: 'A', semanas: SEMANAS.slice(0, 1), fotosPorSemana: 2, bytes: 1000 });
  await recalcularUso(env);

  const uso = await relatorioDeUso(env);

  igual(uso.bytes, 2000, 'bytes em uso');
  igual(uso.tetoBytes, TETO_BYTES, 'teto relatado');
  igual(uso.fotos, 2, 'fotografias vivas');
  igual(uso.semanasGuardadas, SEMANAS_GUARDADAS, 'janela relatada');
  confirmar(uso.r2Ativo, 'o R2 do teste esta ativo');
});

/* ------------------------------------------- integracao com o upload */

/* JPEG minimo que passa pelo `tipoReal()`: assinatura ff d8 ff e doze bytes. */
function jpegFalso(tamanho = 4096) {
  const bytes = new Uint8Array(tamanho);
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  return bytes;
}

function pedidoDeFoto(bytes) {
  return {
    headers: { get: (nome) => (String(nome).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0))
  };
}

function prepararUpload(db) {
  db.prepare('insert into obras (id, nome) values (?, ?)').run('A', 'Obra A');
  db.prepare('insert into pavimentos (id, obra_id, nome) values (?, ?, ?)')
    .run('A-pav', 'A', 'Terreo');
  db.prepare('insert into relatorios_foto (id, obra_id, pavimento_id, data) values (?, ?, ?, ?)')
    .run('A-rel', 'A', 'A-pav', SEMANAS[0]);
}

teste('o reenvio da mesma foto nao dobra o contador', async () => {
  const { db, env } = montarAmbiente();
  prepararUpload(db);
  const sessao = { id: null, nivelAcesso: 'engenheiro' };
  const imagem = jpegFalso();

  const parametros = new URLSearchParams({ relatorio: 'A-rel', id: 'foto-1' });
  const primeira = await fotos.enviar(env, sessao, pedidoDeFoto(imagem), parametros);
  confirmar(!primeira.erro, `primeiro envio falhou: ${primeira.erro || ''}`);
  igual(await usoRegistrado(env), imagem.length, 'contador depois do primeiro envio');

  /* A fila offline reenvia quando a resposta se perde no caminho. O `insert or
     replace` torna isso inofensivo para a tabela; o contador tem de somar
     apenas a diferenca, senao uma rede ruim infla o uso e o teto passa a
     recusar envio com espaco sobrando. */
  const segunda = await fotos.enviar(env, sessao, pedidoDeFoto(imagem), parametros);
  confirmar(!segunda.erro, `reenvio falhou: ${segunda.erro || ''}`);
  igual(await usoRegistrado(env), imagem.length, 'o reenvio nao podia somar de novo');
});

teste('com a cota no teto o upload e recusado com 507, nao com erro generico', async () => {
  const { db, env } = montarAmbiente();
  prepararUpload(db);
  await somarUso(env, TETO_BYTES);

  const resultado = await fotos.enviar(
    env, { id: null, nivelAcesso: 'engenheiro' }, pedidoDeFoto(jpegFalso()),
    new URLSearchParams({ relatorio: 'A-rel', id: 'foto-1' })
  );

  /* 507 e deliberado: a fila do painel descarta 4xx e segura 5xx, entao este
     codigo e o que mantem a foto no aparelho ate a limpeza liberar espaco. */
  igual(resultado.status, 507, 'status de armazenamento cheio');
  confirmar(/Armazenamento cheio/.test(resultado.erro), 'a mensagem tem de explicar o motivo');
  igual(env.FOTOS.objetos.size, 0, 'nada podia ter sido gravado no bucket');
});

teste('foto revivida por fila antiga volta a contar na cota', async () => {
  const { db, env } = montarAmbiente();
  prepararUpload(db);
  const sessao = { id: null, nivelAcesso: 'engenheiro' };
  const imagem = jpegFalso();
  const parametros = new URLSearchParams({ relatorio: 'A-rel', id: 'foto-1' });

  await fotos.enviar(env, sessao, pedidoDeFoto(imagem), parametros);
  await fotos.excluir(env, { id: null, nivelAcesso: 'administrador' }, 'foto-1');
  igual(await usoRegistrado(env), 0, 'depois de apagar');

  /* Um aparelho que ficou semanas sem rede ainda tem a foto na fila. O `insert
     or replace` do upload ressuscita a linha — o `excluido_em` volta a NULL —
     logo os bytes voltam a ocupar o bucket e TEM de voltar a contar. Procurar o
     registro anterior sem filtrar por `excluido_em` faria o contador achar que
     a foto ja estava paga e ficar abaixo da verdade ate o recalculo noturno. */
  const revivida = await fotos.enviar(env, sessao, pedidoDeFoto(imagem), parametros);

  confirmar(!revivida.erro, `reenvio falhou: ${revivida.erro || ''}`);
  igual(await usoRegistrado(env), imagem.length, 'a foto revivida tem de voltar a contar');
  igual(await recalcularUso(env), imagem.length, 'e o recalculo confirma o mesmo numero');
});

teste('a exclusao manual devolve os bytes a cota na hora', async () => {
  const { db, env } = montarAmbiente();
  prepararUpload(db);
  const sessao = { id: null, nivelAcesso: 'administrador' };
  const imagem = jpegFalso();

  await fotos.enviar(
    env, sessao, pedidoDeFoto(imagem),
    new URLSearchParams({ relatorio: 'A-rel', id: 'foto-1' })
  );
  igual(await usoRegistrado(env), imagem.length, 'uso depois do envio');

  const saida = await fotos.excluir(env, sessao, 'foto-1');

  confirmar(!saida.erro, `exclusao falhou: ${saida.erro || ''}`);
  igual(await usoRegistrado(env), 0, 'o espaco tem de aparecer livre na hora');
});

await executar('Retenção de fotografias e teto de cota');

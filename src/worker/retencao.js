/* Retencao das fotografias: janela de 4 semanas por obra, e teto de cota.

   POR QUE ISTO EXISTE

   O plano gratuito do R2 da 10 GB, e durante os testes o sistema inteiro tem de
   caber nisso. A regra definida pela NBZ: guardar as quatro semanas mais
   recentes de relatorio e apagar a mais antiga quando entra uma nova. Com as
   semanas 1 a 4 no bucket, a chegada da 5a apaga a 1a; a 6a apaga a 2a.

   O QUE SAI E O QUE FICA

   Sai o binario do R2, que e onde estao praticamente todos os bytes. Fica a
   linha no D1 com legenda, data, autor e vinculo de setor — algumas centenas de
   bytes, numa cota separada que nao concorre com os 10 GB. Por isso a obra nao
   perde numero nenhum: perde a imagem, nao o registro. Area, m2, situacao e
   historico de setor vivem em outras tabelas e nao sao tocados aqui.

   A JANELA E POR OBRA, NAO GLOBAL

   Com cinco obras ativas e uma janela global de quatro semanas, a visita de uma
   obra empurraria para fora a semana de outra, e a obra mais movimentada
   apagaria o historico das demais. Por obra, cada uma guarda as suas quatro.

   AS PLANTAS NAO ENTRAM

   `pavimentos.planta_r2_key` tambem mora no R2 e pesa mais que uma foto (ate
   10 MB), mas nao e registro semanal: e a base sobre a qual os setores sao
   desenhados. Apaga-la deixaria a obra sem planta e os setores sem referencia.

   QUAL DATA DEFINE A SEMANA

   A do relatorio, nao a da foto. O relatorio e o que e feito semanalmente; uma
   foto anexada com atraso pertence a semana da visita que ela documenta.
*/
import { agora } from './cripto.js';

/* Quantas semanas de fotografia cada obra conserva. */
export const SEMANAS_GUARDADAS = 4;

/* Teto de uso do R2: 9,5 GB dos 10 GB do plano gratuito. A folga de 0,5 GB
   existe porque a contagem aqui soma o que o sistema gravou, e o numero real
   da conta inclui as plantas e qualquer objeto orfao de um delete que falhou. */
export const TETO_BYTES = Math.round(9.5 * 1024 * 1024 * 1024);

/* Teto por execucao do cron. Sem ele, a primeira passagem numa base grande
   tentaria apagar tudo de uma vez e estouraria o tempo de CPU do Worker,
   deixando o trabalho pela metade e sem registro de onde parou. Com ele, a
   limpeza se completa ao longo de algumas noites. */
const MAXIMO_POR_EXECUCAO = 2000;

/* Limite de parametros por statement no SQLite. Lotes de 200 ficam bem abaixo
   dos 999 e cabem com folga no `bind`. */
const TAMANHO_LOTE = 200;

/* O R2 aceita apagar varias chaves num pedido so. */
const TAMANHO_LOTE_R2 = 1000;

const CHAVE_USO = 'r2_bytes';

function emLotes(itens, tamanho) {
  const lotes = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

/* ------------------------------------------------------- contador de uso */

/* Por que um contador em vez de `select sum(bytes) from fotos`.

   O SUM varre a tabela inteira, e o D1 cobra isso como linhas lidas: com 40 mil
   fotos, cada upload gastaria 40 mil das 5 milhoes de leituras diarias do plano
   gratuito, o que daria pouco mais de cem envios por dia. O contador responde
   em uma linha. A soma verdadeira e recalculada uma vez por dia no cron, que e
   quando a varredura custa pouco e corrige qualquer desvio. */
export async function usoRegistrado(env) {
  const linha = await env.DB.prepare('select valor from armazenamento where chave = ?')
    .bind(CHAVE_USO).first();
  return Number(linha && linha.valor) || 0;
}

/* `delta` em bytes, negativo ao apagar. O `max(0, ...)` protege contra desvio
   acumulado deixar o contador negativo, o que faria o teto parar de valer. */
export async function somarUso(env, delta) {
  if (!delta) return;
  await env.DB.prepare(
    'insert into armazenamento (chave, valor) values (?, max(0, ?))'
    + ' on conflict(chave) do update set valor = max(0, armazenamento.valor + ?)'
  ).bind(CHAVE_USO, delta, delta).run();
}

/* Recalcula o contador a partir da verdade da tabela. Roda no cron. */
export async function recalcularUso(env) {
  const linha = await env.DB.prepare(
    'select coalesce(sum(bytes), 0) as total from fotos where excluido_em is null'
  ).first();
  const total = Number(linha && linha.total) || 0;
  await env.DB.prepare(
    'insert into armazenamento (chave, valor) values (?, ?)'
    + ' on conflict(chave) do update set valor = excluded.valor'
  ).bind(CHAVE_USO, total).run();
  return total;
}

/* Cabe mais `bytes` sem passar do teto? Chamado antes de gravar no R2. */
export async function cabeNaCota(env, bytes) {
  const usado = await usoRegistrado(env);
  return usado + Number(bytes || 0) <= TETO_BYTES;
}

/* ------------------------------------------------------- leitura da cota */

/* Numeros para o painel mostrar. Usa o contador, nao a varredura. */
export async function relatorioDeUso(env) {
  const usado = await usoRegistrado(env);
  const linha = await env.DB.prepare(
    'select count(*) as fotos from fotos where excluido_em is null'
  ).first();
  return {
    bytes: usado,
    tetoBytes: TETO_BYTES,
    porcentagem: TETO_BYTES ? Math.round((usado / TETO_BYTES) * 1000) / 10 : 0,
    fotos: Number(linha && linha.fotos) || 0,
    semanasGuardadas: SEMANAS_GUARDADAS,
    r2Ativo: Boolean(env.FOTOS)
  };
}

/* ------------------------------------------------------------- retencao */

/* Uma linha por obra e semana, da semana mais recente para a mais antiga.

   `%W` numera a semana do ano com a segunda-feira como primeiro dia, e o
   formato `AAAA-Wnn` com zero a esquerda ordena corretamente como texto,
   inclusive na virada do ano: '2027-W00' vem depois de '2026-W52'.

   Fotos cujo relatorio foi excluido entram na conta de proposito: o binario
   continua ocupando cota no bucket, e e justamente ele que se quer tirar. */
async function semanasComFoto(env) {
  const { results } = await env.DB.prepare(
    "select r.obra_id as obra,"
    + " strftime('%Y-W%W', r.data) as semana,"
    + ' count(*) as fotos,'
    + ' coalesce(sum(f.bytes), 0) as bytes'
    + ' from fotos f'
    + ' join relatorios_foto r on r.id = f.relatorio_id'
    + ' where f.excluido_em is null'
    + ' group by obra, semana'
    + ' order by obra asc, semana desc'
  ).all();
  return results || [];
}

/* Dada a lista acima, quais pares obra/semana passaram da janela.

   A consulta ja vem ordenada por semana decrescente dentro de cada obra, logo
   as `SEMANAS_GUARDADAS` primeiras de cada obra sao as que ficam. */
export function semanasVencidas(linhas, semanasGuardadas = SEMANAS_GUARDADAS) {
  const vistasPorObra = new Map();
  const vencidas = [];
  for (const linha of linhas) {
    const vistas = (vistasPorObra.get(linha.obra) || 0) + 1;
    vistasPorObra.set(linha.obra, vistas);
    if (vistas > semanasGuardadas) vencidas.push(linha);
  }
  return vencidas;
}

async function fotosDaSemana(env, obra, semana, limite) {
  const { results } = await env.DB.prepare(
    'select f.id, f.r2_key, f.bytes'
    + ' from fotos f'
    + ' join relatorios_foto r on r.id = f.relatorio_id'
    + ' where f.excluido_em is null'
    + ' and r.obra_id = ?'
    + " and strftime('%Y-W%W', r.data) = ?"
    + ' order by f.data asc'
    + ' limit ?'
  ).bind(obra, semana, limite).all();
  return results || [];
}

/* Marca no D1 antes de apagar no R2, pela mesma razao de `fotos.excluir`: se o
   delete no R2 falhar, sobra objeto orfao ocupando cota, que e incomodo e
   recuperavel. Na ordem inversa sobraria linha apontando para arquivo que nao
   existe, e a galeria mostraria imagem quebrada.

   A exclusao e logica: `/sync/baixar` manda `excluidoEm` para os aparelhos, que
   ja pulam a foto marcada. E assim que o celular do engenheiro larga a copia no
   IndexedDB em vez de continuar exibindo foto que o servidor nao tem mais. */
async function apagar(env, fotos) {
  const carimbo = agora();
  for (const lote of emLotes(fotos.map((foto) => foto.id), TAMANHO_LOTE)) {
    const marcas = lote.map(() => '?').join(',');
    await env.DB.prepare(
      'update fotos set excluido_em = ?, atualizado_em = ?'
      + ' where id in (' + marcas + ') and excluido_em is null'
    ).bind(carimbo, carimbo, ...lote).run();
  }

  if (env.FOTOS) {
    for (const lote of emLotes(fotos.map((foto) => foto.r2_key), TAMANHO_LOTE_R2)) {
      try {
        await env.FOTOS.delete(lote);
      } catch (falha) {
        /* O objeto fica para a limpeza por prefixo; a foto ja saiu do painel. */
        console.error('Falha ao apagar objetos no R2:', falha);
      }
    }
  }
}

/* Aplica a janela. Devolve resumo para o log do cron.

   Sem o R2 ativo nao ha binario no bucket para apagar, e a unica coisa que a
   rotina faria seria marcar linhas no D1 sem liberar byte nenhum da cota — ou
   seja, perder registro de graca. Por isso ela nao roda nesse estado. Quando o
   bucket for criado, a primeira madrugada ja aplica a janela. */
export async function aplicarRetencao(env) {
  if (!env.FOTOS) {
    return { executada: false, motivo: 'R2 nao ativado', fotos: 0, bytes: 0, semanas: 0 };
  }

  const vencidas = semanasVencidas(await semanasComFoto(env));
  let apagadas = 0;
  let bytes = 0;
  let semanas = 0;

  for (const semana of vencidas) {
    const restante = MAXIMO_POR_EXECUCAO - apagadas;
    if (restante <= 0) break;

    const fotos = await fotosDaSemana(env, semana.obra, semana.semana, restante);
    if (!fotos.length) continue;

    await apagar(env, fotos);
    apagadas += fotos.length;
    bytes += fotos.reduce((soma, foto) => soma + (Number(foto.bytes) || 0), 0);
    semanas += 1;
  }

  return {
    executada: true,
    fotos: apagadas,
    bytes,
    semanas,
    incompleta: apagadas >= MAXIMO_POR_EXECUCAO
  };
}

/* Backup do D1 e das fotografias do R2.

   Rode:  npm run backup            cópia completa
          npm run backup:verificar  testa a restauração da última cópia

   POR QUE ISTO EXISTE

   O Time Travel do D1 restaura o banco a um ponto no tempo sem custo, mas no
   plano gratuito cobre apenas 7 DIAS. Ele resolve o acidente da semana — a
   exclusão errada, a importação que corrompeu — e não resolve nada além disso:
   nem o erro descoberto no mês seguinte, nem a perda da conta, nem a pergunta
   "como estava esta obra em março".

   DUAS CÓPIAS, PORQUE SÃO DUAS COISAS DIFERENTES

   O backup do D1 não protege o R2 e vice-versa: são serviços separados, com
   falhas separadas. Restaurar só o banco deixaria linha de foto apontando para
   objeto que não existe; restaurar só o bucket deixaria imagem sem nenhum
   registro que diga de que obra ela é.

   A CÓPIA DAS FOTOS NÃO É BACKUP — É O ARQUIVO

   Esta é a parte que muda o sentido do script. A retenção apaga do R2 a
   fotografia com mais de quatro semanas, de propósito, para caber nos 10 GB.
   Então esta pasta local não é uma segunda via do que está no bucket: depois de
   quatro semanas ela é a ÚNICA cópia que existe. Se ela não rodar, o registro
   fotográfico da obra desaparece no prazo — não por falha, mas por projeto.

   Por isso o espelho é incremental e nunca apaga: o que saiu do bucket continua
   aqui. É também por isso que esta pasta precisa ir para fora deste computador
   (disco externo, nuvem da empresa) — um backup que mora no mesmo disco que o
   original não é backup.
*/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PASTA = join(raiz, 'backups');
const PASTA_FOTOS = join(PASTA, 'fotos');
const BANCO = 'nbz-obras';
const BUCKET = 'nbz-fotos';

/* As tabelas que precisam ter conteúdo depois de uma restauração de verdade.
   `armazenamento` fica de fora: é contador derivado, recalculado pelo cron. */
const TABELAS = [
  'usuarios', 'obras', 'pavimentos', 'setores', 'setor_situacao_log',
  'relatorios_foto', 'fotos', 'funcionarios', 'presenca', 'atividades'
];

/* Põe aspas em argumento com espaço.

   No Windows o `npx` é um .cmd, então `spawnSync` precisa de `shell: true` — e
   com shell o Node CONCATENA os argumentos sem escapar, como o próprio aviso de
   depreciação dele diz. O caminho deste projeto tem espaços ("Área de
   Trabalho", "pasta nbz med"), então `--output C:\...\Área de Trabalho\...`
   chegava ao wrangler partido em pedaços e ele reclamava de "Unknown arguments:
   de, Trabalho\pasta, nbz".

   Só se aplica quando há shell: sem ele os argumentos vão como vetor e aspas
   extras entrariam no valor, quebrando de um jeito mais difícil de enxergar. */
function comAspas(argumento) {
  const texto = String(argumento);
  if (!/[\s"]/.test(texto)) return texto;
  return `"${texto.replace(/"/g, '\\"')}"`;
}

function wrangler(args, { silencioso = false } = {}) {
  const usaShell = process.platform === 'win32';
  const argumentos = ['wrangler', ...args].map((item) => (usaShell ? comAspas(item) : item));
  const resultado = spawnSync('npx', argumentos, {
    cwd: raiz, encoding: 'utf8', shell: usaShell, maxBuffer: 64 * 1024 * 1024
  });
  const saida = `${resultado.stdout || ''}${resultado.stderr || ''}`;
  if (resultado.status !== 0 && !silencioso) {
    throw new Error(saida.trim() || `wrangler ${args.join(' ')} falhou.`);
  }
  return { saida, ok: resultado.status === 0 };
}

/* O wrangler imprime banner antes do JSON; recortar do primeiro colchete é o
   que torna a leitura imune a mudança de banner entre versões. */
function lerJson(saida) {
  const inicio = saida.indexOf('[');
  const fim = saida.lastIndexOf(']');
  if (inicio < 0 || fim < inicio) throw new Error(`Resposta sem JSON:\n${saida.slice(0, 400)}`);
  return JSON.parse(saida.slice(inicio, fim + 1));
}

function consultar(sql, extras = []) {
  const { saida } = wrangler([
    'd1', 'execute', BANCO, '--remote', '--json', '--command', sql, ...extras
  ]);
  const blocos = lerJson(saida);
  return blocos.flatMap((bloco) => bloco.results || []);
}

function carimbo() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ D1 */

function copiarBanco() {
  mkdirSync(PASTA, { recursive: true });
  const destino = join(PASTA, `d1-${carimbo()}.sql`);
  console.log('[1/3] Exportando o banco D1...');
  wrangler(['d1', 'export', BANCO, '--remote', '--output', destino, '-y']);

  if (!existsSync(destino) || statSync(destino).size === 0) {
    throw new Error('A exportação saiu vazia — a cópia NÃO é confiável.');
  }
  console.log(`      ${destino}  (${mb(statSync(destino).size)})`);
  return destino;
}

/* Grava, ao lado do dump, quantos registros cada tabela tinha no momento da
   exportação.

   É o que transforma a verificação de restauração em verificação de verdade.
   Sem isso ela só imprimia números e deixava a comparação para quem lesse — e
   "10 tabelas recriadas" soa bem mesmo quando o dump perdeu metade das linhas.

   Comparar com a produção na hora de verificar não serviria: entre o backup e a
   conferência alguém pode ter cadastrado uma obra, e a diferença legítima seria
   lida como falha. O retrato tirado junto com o dump é o único parâmetro justo. */
function anotarContagens(destinoSql) {
  const partes = TABELAS.map((tabela) => `(select count(*) from ${tabela}) as ${tabela}`);
  const linhas = consultar(`select ${partes.join(', ')}`);
  const contagens = linhas.length ? linhas[0] : {};
  writeFileSync(`${destinoSql}.contagem.json`, `${JSON.stringify(contagens, null, 2)}\n`, 'utf8');
  const total = Object.values(contagens).reduce((soma, n) => soma + (Number(n) || 0), 0);
  console.log(`      retrato das tabelas anotado: ${total} registro(s) no total`);
  return contagens;
}

/* O bookmark é o ponto de restauração do Time Travel. Guardá-lo ao lado do dump
   é o que permite dizer, depois, "o banco estava assim neste instante" — e, se
   ainda estiver dentro dos 7 dias, restaurar sem precisar do dump. */
function anotarBookmark(destinoSql) {
  const { saida, ok } = wrangler(['d1', 'time-travel', 'info', BANCO], { silencioso: true });
  if (!ok) return;
  const achado = saida.match(/[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/i);
  if (!achado) return;
  writeFileSync(`${destinoSql}.bookmark.txt`, `${achado[0]}\n`, 'utf8');
  console.log(`      bookmark anotado: ${achado[0]}`);
}

/* ------------------------------------------------------------------ R2 */

/* Fotografias e plantas, nas duas tabelas que guardam chave de objeto. */
function chavesDoBucket() {
  const fotos = consultar(
    'select r2_key as chave, bytes from fotos where excluido_em is null'
  );
  const plantas = consultar(
    'select planta_r2_key as chave, 0 as bytes from pavimentos'
    + ' where planta_r2_key is not null and planta_r2_key <> \'\' and excluido_em is null'
  );
  return [...fotos, ...plantas].filter((linha) => linha.chave);
}

function espelharFotos() {
  console.log('[2/3] Espelhando as fotografias do R2...');
  const chaves = chavesDoBucket();
  if (!chaves.length) {
    console.log('      nenhuma fotografia no banco ainda.');
    return { baixadas: 0, existentes: 0, falhas: [], total: 0 };
  }

  let baixadas = 0;
  let existentes = 0;
  const falhas = [];

  for (const { chave, bytes } of chaves) {
    const destino = join(PASTA_FOTOS, chave);
    /* Incremental: o que já está aqui com o tamanho certo não é rebaixado. Sem
       isso, cada execução refaria o espelho inteiro — e, com milhares de fotos,
       consumiria as operações de leitura do plano gratuito à toa. */
    if (existsSync(destino) && (!bytes || statSync(destino).size === Number(bytes))) {
      existentes += 1;
      continue;
    }
    mkdirSync(dirname(destino), { recursive: true });
    const { ok, saida } = wrangler(
      ['r2', 'object', 'get', `${BUCKET}/${chave}`, '--file', destino, '--remote'],
      { silencioso: true }
    );
    if (ok && existsSync(destino) && statSync(destino).size > 0) {
      baixadas += 1;
    } else {
      falhas.push({ chave, motivo: saida.trim().split('\n').pop() || 'desconhecido' });
    }
  }

  console.log(`      ${baixadas} baixadas, ${existentes} já tinham cópia, ${falhas.length} falharam`);
  for (const falha of falhas.slice(0, 10)) {
    console.log(`      FALHA ${falha.chave}: ${falha.motivo}`);
  }
  return { baixadas, existentes, falhas, total: chaves.length };
}

/* ------------------------------------------------- teste de restauração */

/* Restaura a cópia mais recente num banco LOCAL descartável e confere se os
   dados chegaram. É o passo que separa "temos backup" de "temos backup que
   funciona" — arquivo .sql truncado ou com erro de sintaxe só se revela na
   restauração, e descobrir isso no dia do acidente é tarde.

   `--persist-to` manda o estado para uma pasta própria: o banco de
   desenvolvimento de quem roda o teste fica intacto. */
function verificarRestauracao() {
  const dumps = existsSync(PASTA)
    ? readdirSync(PASTA).filter((nome) => nome.endsWith('.sql')).sort()
    : [];
  if (!dumps.length) throw new Error('Nenhuma cópia em backups/ para verificar. Rode `npm run backup`.');

  const nome = dumps[dumps.length - 1];
  const dump = join(PASTA, nome);
  const estado = join(PASTA, '.verificacao');
  console.log(`[3/3] Testando a restauração de ${nome}...`);

  /* Começa de um banco vazio. Reaproveitar o estado de uma verificação anterior
     faria as linhas antigas contarem como se tivessem vindo deste dump — e um
     dump truncado passaria no teste. */
  rmSync(estado, { recursive: true, force: true });

  wrangler(['d1', 'execute', BANCO, '--local', '--persist-to', estado, '--file', dump, '-y']);

  const contagens = [];
  for (const tabela of TABELAS) {
    const { saida, ok } = wrangler([
      'd1', 'execute', BANCO, '--local', '--persist-to', estado, '--json',
      '--command', `select count(*) as n from ${tabela}`
    ], { silencioso: true });
    if (!ok) {
      contagens.push({ tabela, n: null });
      continue;
    }
    const linhas = lerJson(saida).flatMap((bloco) => bloco.results || []);
    contagens.push({ tabela, n: linhas.length ? Number(linhas[0].n) : null });
  }

  const quebradas = contagens.filter((item) => item.n === null);
  if (quebradas.length) {
    throw new Error(
      `A restauração não recriou estas tabelas: ${quebradas.map((i) => i.tabela).join(', ')}.`
      + '\nA cópia NÃO serve para restaurar.'
    );
  }

  /* Compara com o retrato tirado junto do dump. É aqui que a verificação deixa
     de ser informativa e passa a poder reprovar. */
  const arquivoRetrato = `${dump}.contagem.json`;
  let esperado = null;
  if (existsSync(arquivoRetrato)) {
    try {
      esperado = JSON.parse(readFileSync(arquivoRetrato, 'utf8'));
    } catch {
      esperado = null;
    }
  }

  const divergentes = [];
  console.log('      tabelas restauradas:');
  for (const { tabela, n } of contagens) {
    const alvo = esperado ? Number(esperado[tabela]) : null;
    const ok = alvo === null || Number.isNaN(alvo) || alvo === n;
    if (!ok) divergentes.push({ tabela, esperado: alvo, obtido: n });
    const comparacao = alvo === null || Number.isNaN(alvo)
      ? ''
      : (ok ? '  ok' : `  DIVERGE (esperado ${alvo})`);
    console.log(`        ${tabela.padEnd(20)} ${String(n).padStart(6)} registro(s)${comparacao}`);
  }

  if (divergentes.length) {
    throw new Error(
      'A restauração não reproduziu o que o backup registrou: '
      + divergentes.map((d) => `${d.tabela} ${d.obtido}/${d.esperado}`).join(', ')
      + '.\nA cópia NÃO serve para restaurar.'
    );
  }

  if (!esperado) {
    console.log('      (sem retrato ao lado do dump: só dá para confirmar que as tabelas existem)');
  } else {
    const total = contagens.reduce((soma, item) => soma + item.n, 0);
    console.log(`      CONFERE: ${contagens.length} tabelas, ${total} registro(s), igual ao backup.`);
  }
  console.log(`      estado de teste em ${estado} (pode apagar).`);
}

/* ------------------------------------------------------------- execucao */

async function principal() {
  if (process.argv.includes('--verificar')) {
    verificarRestauracao();
    return;
  }

  const dump = copiarBanco();
  anotarBookmark(dump);
  anotarContagens(dump);
  const fotos = espelharFotos();

  console.log('\nResumo');
  console.log(`  banco:      ${dump}`);
  console.log(`  fotos:      ${fotos.baixadas + fotos.existentes}/${fotos.total} com cópia local`);
  if (fotos.falhas.length) {
    console.log(`  ATENCAO:    ${fotos.falhas.length} fotografia(s) sem cópia — repita o backup.`);
    process.exitCode = 1;
  }
  console.log('\nFalta o passo que a maioria esquece: levar backups/ para FORA deste');
  console.log('computador. No mesmo disco do original, isto não protege contra perda do disco.');
  console.log('\nPara conferir que a cópia restaura mesmo:  npm run backup:verificar');
}

principal().catch((erro) => {
  console.error(`Falha no backup: ${erro.message}`);
  process.exitCode = 1;
});

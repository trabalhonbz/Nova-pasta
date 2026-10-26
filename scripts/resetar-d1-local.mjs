/* Recria o banco D1 LOCAL do zero.

   Por que existe: `create table if not exists` nao altera tabela que ja existe.
   Quando uma restricao do schema muda — um CHECK novo, uma coluna — reaplicar o
   arquivo nao surte efeito, e o erro aparece so na hora de gravar, como um 500
   generico. Este script derruba as tabelas e aplica o schema outra vez.

   APAGA TODOS OS DADOS LOCAIS. Nunca aponta para a nuvem: nao aceita `--remote`
   nem nada parecido, de proposito. Para mudar o schema em producao o caminho e
   uma migracao versionada, que preserva o que ja esta gravado.

   Rode com `npm run db:reset`.
*/
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const schema = readFileSync(resolve(raiz, 'src', 'schema.sql'), 'utf8');

/* Na ordem inversa das dependencias: filha antes da mae, senao a chave
   estrangeira impede o drop. */
const TABELAS = [
  'atividades', 'presenca', 'funcionarios', 'fotos', 'relatorios_foto',
  'setor_situacao_log', 'setores', 'pavimentos', 'obras',
  'tentativas_login', 'sessoes', 'usuarios'
];

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: raiz, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

console.log('Derrubando as tabelas locais…');
const drops = TABELAS.map((tabela) => `drop table if exists ${tabela};`).join(' ');
wrangler(['d1', 'execute', 'nbz-obras', '--local', '--command', `"${drops}"`]);

console.log('Aplicando src/schema.sql…');
wrangler(['d1', 'execute', 'nbz-obras', '--local', '--file=src/schema.sql']);

const conferencia = wrangler([
  'd1', 'execute', 'nbz-obras', '--local',
  '--command', '"select count(*) as tabelas from sqlite_master where type=\'table\'"'
]);
const encontrado = conferencia.match(/"tabelas":\s*(\d+)/);
console.log(`Pronto: ${encontrado ? encontrado[1] : '?'} tabelas no banco local.`);
console.log('Os usuários foram apagados — o painel voltará a pedir o cadastro inicial.');
console.log(`Schema aplicado: ${schema.split('\n').length} linhas.`);

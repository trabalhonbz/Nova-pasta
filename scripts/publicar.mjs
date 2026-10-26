/* Publica o sistema inteiro na Cloudflare, de uma vez.

   Pré-requisito, e o único passo manual: a variável CLOUDFLARE_API_TOKEN.
   Criar a primeira credencial é o que prova a identidade de quem publica, e por
   isso nenhum provedor deixa automatizar essa parte.

     PowerShell:  $env:CLOUDFLARE_API_TOKEN="..."
     Bash:        export CLOUDFLARE_API_TOKEN="..."

   Depois:  npm run publicar

   O que este script faz, nesta ordem:
     1. confere o token e mostra a conta
     2. cria o banco D1 (ou reaproveita) e grava o database_id no wrangler.toml
     3. cria o bucket R2 (ou reaproveita)
     4. aplica src/schema.sql no banco remoto
     5. define o PEPPER, se ainda não existir
     6. publica o Worker e imprime o endereço

   É seguro repetir: cada etapa reconhece o que já existe e segue adiante.

   O PEPPER é gerado uma vez e guardado em .pepper-producao.txt, que o .gitignore
   ignora. Guarde esse arquivo: trocar o PEPPER invalida TODAS as senhas, e aí
   cada pessoa precisa de redefinição pelo administrador.
*/
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const raiz = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = resolve(raiz, 'wrangler.toml');
const ARQUIVO_PEPPER = resolve(raiz, '.pepper-producao.txt');
const BANCO = 'nbz-obras';
const BUCKET = 'nbz-fotos';

/* Junta stdout e stderr.

   O wrangler escreve boa parte do que interessa no stderr — inclusive o
   `database_id` que sai da criação do banco. Capturar só o stdout devolvia
   string vazia, e o script concluía que a criação tinha falhado quando o banco
   havia sido criado. */
function wrangler(args, { silencioso = false } = {}) {
  const resultado = spawnSync('npx', ['wrangler', ...args], {
    cwd: raiz, encoding: 'utf8', shell: process.platform === 'win32'
  });
  const saida = `${resultado.stdout || ''}${resultado.stderr || ''}`;
  if (resultado.status !== 0 && !silencioso) {
    throw new Error(saida.trim() || `wrangler ${args[0]} falhou.`);
  }
  return saida;
}

function etapa(numero, texto) {
  console.log(`\n[${numero}/6] ${texto}`);
}

/* ------------------------------------------------------------------ 1 */

if (!process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Falta a variável CLOUDFLARE_API_TOKEN.\n');
  console.error('Crie o token em dash.cloudflare.com/profile/api-tokens com as permissões:');
  console.error('  Account · Workers Scripts    · Edit');
  console.error('  Account · D1                 · Edit');
  console.error('  Account · Workers R2 Storage · Edit');
  console.error('  Account · Account Settings   · Read\n');
  console.error('Depois:  $env:CLOUDFLARE_API_TOKEN="o-token"   (PowerShell)');
  process.exit(1);
}

etapa(1, 'Conferindo o token…');
const quem = wrangler(['whoami'], { silencioso: true });
const conta = quem.match(/│\s+([^│]+?)\s+│\s+([0-9a-f]{32})\s+│/);
if (conta) {
  console.log(`      Conta: ${conta[1].trim()} (${conta[2]})`);
} else if (/not authenticated|Unable to authenticate/i.test(quem)) {
  console.error('      Token inválido ou sem permissão. Confira as permissões acima.');
  process.exit(1);
} else {
  console.log('      Token aceito.');
}

/* ------------------------------------------------------------------ 2 */

etapa(2, `Banco D1 "${BANCO}"…`);
let config = readFileSync(CONFIG, 'utf8');
let idDoBanco = (config.match(/database_id\s*=\s*"([^"]+)"/) || [])[1] || '';

if (idDoBanco && idDoBanco !== 'COLE_AQUI_O_ID_DO_D1') {
  console.log(`      Já configurado: ${idDoBanco}`);
} else {
  const saida = wrangler(['d1', 'create', BANCO], { silencioso: true });
  /* O id aparece tanto na criação quanto na mensagem de "já existe". */
  const achado = saida.match(/database_id\s*=\s*"([^"]+)"/)
    || saida.match(/"uuid"\s*:\s*"([0-9a-f-]{36})"/)
    || saida.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!achado) {
    console.error('      Não consegui descobrir o database_id. Saída do wrangler:\n');
    console.error(saida);
    console.error('\n      Crie pelo painel e cole o id em wrangler.toml.');
    process.exit(1);
  }
  idDoBanco = achado[1];
  config = config.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${idDoBanco}"`);
  writeFileSync(CONFIG, config, 'utf8');
  console.log(`      Criado e gravado no wrangler.toml: ${idDoBanco}`);
}

/* ------------------------------------------------------------------ 3 */

etapa(3, `Bucket R2 "${BUCKET}"…`);

/* O binding do R2 pode estar comentado no wrangler.toml, enquanto o
   armazenamento não é ativado na conta. Tentar criar o bucket nesse caso só
   produziria um erro que não quer dizer nada. */
const r2Ligado = /^\s*\[\[r2_buckets\]\]/m.test(config);

if (!r2Ligado) {
  console.log('      Desligado no wrangler.toml; pulando.');
  console.log('      As fotografias ficam no aparelho e entram na fila de envio.');
  console.log('      Para ligar: ative o R2 no painel, descomente o bloco [[r2_buckets]]');
  console.log('      e rode de novo. A fila acumulada sobe sozinha depois disso.');
} else {
  const r2 = wrangler(['r2', 'bucket', 'create', BUCKET], { silencioso: true });
  if (/already exists|já existe/i.test(r2)) {
    console.log('      Já existia; seguindo.');
  } else if (/created|criado|Successfully/i.test(r2)) {
    console.log('      Criado.');
  } else if (/enable R2|10042/i.test(r2)) {
    console.error('      O R2 não está ativado nesta conta.');
    console.error('      Ative em dash.cloudflare.com → Armazenamento de objetos,');
    console.error('      ou comente o bloco [[r2_buckets]] no wrangler.toml para publicar sem ele.');
    process.exit(1);
  } else {
    console.log('      Não consegui confirmar. Saída:');
    console.log(`      ${r2.trim().split('\n').slice(-3).join('\n      ')}`);
  }
}

/* ------------------------------------------------------------------ 4 */

etapa(4, 'Aplicando src/schema.sql no banco remoto…');
const schema = wrangler(['d1', 'execute', BANCO, '--file=src/schema.sql', '--remote', '-y'], { silencioso: true });
if (/error|erro/i.test(schema) && !/already exists/i.test(schema)) {
  console.log('      Atenção, a saída trouxe erro:');
  console.log(`      ${schema.trim().split('\n').slice(-5).join('\n      ')}`);
} else {
  console.log('      Tabelas aplicadas.');
}

/* ------------------------------------------------------------------ 5 */

etapa(5, 'Publicando o Worker…');
const deploy = wrangler(['deploy'], { silencioso: true });
const endereco = (deploy.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];

if (!endereco) {
  console.log(deploy);
  console.error('\nNão consegui ler o endereço publicado. Veja a saída acima.');
  process.exit(1);
}

console.log(`      Publicado em ${endereco}`);

/* ------------------------------------------------------------------ 6 */

/* O segredo vem DEPOIS do deploy, e não antes: `wrangler secret put` recusa um
   Worker que ainda não existe. Entre as duas etapas o Worker responde "sem
   PEPPER configurado" — que é o comportamento certo, e dura segundos. */
etapa(6, 'Segredo PEPPER…');
const segredos = wrangler(['secret', 'list'], { silencioso: true });
if (/PEPPER/.test(segredos)) {
  console.log('      Já definido; mantido como está.');
  console.log('      (Trocá-lo invalidaria todas as senhas já cadastradas.)');
} else {
  const pepper = existsSync(ARQUIVO_PEPPER)
    ? readFileSync(ARQUIVO_PEPPER, 'utf8').trim()
    : randomBytes(48).toString('base64url');
  writeFileSync(ARQUIVO_PEPPER, `${pepper}\n`, 'utf8');
  /* `shell: true` no Windows: sem ele o `npx` não é encontrado e o spawn falha
     com ENOENT, porque o executável real é um .cmd. */
  execFileSync('npx', ['wrangler', 'secret', 'put', 'PEPPER'], {
    cwd: raiz, input: `${pepper}\n`, encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32'
  });
  console.log('      Definido e guardado em .pepper-producao.txt (fora do git).');
  console.log('      GUARDE ESSE ARQUIVO: sem ele, trocar o segredo zera todas as senhas.');
}

console.log('\n─────────────────────────────────────────────');
console.log('Falta um passo, e é uma linha. Em index.html:');
console.log(`\n  <meta name="nbz-api" content="${endereco}">\n`);
console.log('E acrescente a origem do painel em ORIGENS, no wrangler.toml,');
console.log('com o endereço onde o index.html for publicado.');
console.log('─────────────────────────────────────────────');

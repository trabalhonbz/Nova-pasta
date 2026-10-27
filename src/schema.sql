/* Schema D1 (SQLite) do painel NBZ de gestao de obras.
   Espelha as estruturas que o index.html mantem hoje no localStorage.

   Convencoes:
   - id TEXT: o app gera com crypto.randomUUID(); o Worker usa o mesmo formato.
   - datas TEXT em ISO-8601, como o `new Date().toISOString()` do app.
   - atualizado_em / excluido_em existem em toda tabela sincronizavel: o cliente
     offline pede "o que mudou depois de X" e a exclusao e logica, para que
     apagar num aparelho propague em vez de reaparecer no sync seguinte.
   - pontos e correcoes ficam em JSON TEXT; SQLite nao tem array e o app ja
     trata esses campos como blocos opacos.

   Aplicar:  npx wrangler d1 execute nbz-obras --file=src/schema.sql --remote
*/

pragma foreign_keys = on;

/* ---------------------------------------------------------------- usuarios */
/* O administrador cadastra as pessoas pelo proprio painel, como o dialogo de
   usuarios do index.html ja faz hoje — por isso senha mora aqui, e nao num
   provedor de identidade externo.

   `senha_hash` e PBKDF2-SHA256 calculado NO WORKER, nunca no navegador: se o
   cliente enviasse o hash pronto, o hash viraria a senha e qualquer um que o
   interceptasse entraria sem conhecer a original.

   `precisa_trocar_senha` cobre a senha provisoria que o administrador define
   no cadastro: o primeiro login obriga a troca. */
create table if not exists usuarios (
  id                   text primary key,
  usuario              text not null unique,
  nome                 text not null,
  email                text,
  /* Os cinco cargos sao os mesmos de `roleDefinitions` no index.html, que e
     quem de fato aplica permissao na interface. O diagrama inicial falava de
     'diretoria', cargo que o painel nunca teve: aceita-lo aqui criaria usuario
     com cargo que `roleOf()` nao reconhece, e que cairia no ultimo da lista
     ('cliente') sem ninguem perceber. */
  nivel_acesso         text not null check (nivel_acesso in ('administrador', 'engenheiro', 'encarregado', 'tecnico', 'cliente')),
  senha_hash           text not null,
  senha_salt           text not null,
  senha_iteracoes      integer not null default 210000,
  precisa_trocar_senha integer not null default 1 check (precisa_trocar_senha in (0, 1)),
  ativo                integer not null default 1 check (ativo in (0, 1)),
  criado_por           text references usuarios(id),
  criado_em            text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em          text
);

create index if not exists idx_usuarios_sync on usuarios(atualizado_em);

/* ---------------------------------------------------------------- sessoes */
/* Token opaco aleatorio, nao JWT: revogar um JWT exige lista de bloqueio ou
   expiracao curta com refresh, enquanto apagar uma linha daqui derruba a
   sessao na hora — o que importa quando alguem sai da empresa.

   Guarda-se o HASH do token (SHA-256). Um vazamento desta tabela nao da acesso
   a nenhuma conta, do mesmo jeito que o de senhas nao da. */
create table if not exists sessoes (
  id          text primary key,
  token_hash  text not null unique,
  usuario_id  text not null references usuarios(id) on delete cascade,
  criada_em   text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expira_em   text not null,
  ultimo_uso  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_agent  text not null default ''
);

create index if not exists idx_sessoes_usuario on sessoes(usuario_id);
create index if not exists idx_sessoes_expiracao on sessoes(expira_em);

/* ------------------------------------------------------ tentativas_login */
/* A trava de 5 tentativas do painel conta no localStorage do proprio
   navegador, ou seja, no equipamento de quem ataca: basta limpar os dados para
   zerar. Contar no servidor e o unico lugar onde a trava vale. */
create table if not exists tentativas_login (
  id        integer primary key autoincrement,
  usuario   text not null,
  origem    text not null default '',
  sucesso   integer not null default 0 check (sucesso in (0, 1)),
  quando    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_tentativas_usuario on tentativas_login(usuario, quando);

/* ------------------------------------------------------------------- obras */
create table if not exists obras (
  id            text primary key,
  nome          text not null,
  cidade        text not null default '',
  cliente       text not null default '',
  responsavel   text not null default '',
  sistema       text not null default 'A definir',
  situacao      text not null default 'Em andamento',
  data_inicio   text,
  imagem_url    text not null default '',
  criado_por    text references usuarios(id),
  criado_em     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em   text
);

create index if not exists idx_obras_sync on obras(atualizado_em);

/* -------------------------------------------------------------- pavimentos */
/* `ordem` substitui o floorIndex do app, que hoje e a posicao no array e
   se desloca quando um pavimento do meio e removido. */
create table if not exists pavimentos (
  id             text primary key,
  obra_id        text not null references obras(id) on delete cascade,
  nome           text not null,
  area_total     real not null default 0,
  ordem          integer not null default 0,
  planta_r2_key  text,
  planta_largura integer not null default 0,
  planta_altura  integer not null default 0,
  planta_arquivo text not null default '',
  atualizado_em  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em    text
);

create index if not exists idx_pavimentos_obra on pavimentos(obra_id);
create index if not exists idx_pavimentos_sync on pavimentos(atualizado_em);

/* ----------------------------------------------------------------- setores */
/* `pontos`: JSON com [{x, y}] em percentual da planta, como o app ja grava.
   `situacao` e cache da ultima linha de setor_situacao_log — a verdade
   historica fica no log, nao neste campo.

   AS QUATRO SITUACOES, E UMA ARMADILHA DE NOME

   Os valores sao os mesmos de `regionStatusOptions` no index.html. Traduzi-los
   aqui criaria dois vocabularios para manter em sincronia, e o CHECK recusaria
   em silencio tudo que divergisse.

     valor gravado  | rotulo na tela
     ---------------|----------------
     executed       | Finalizado
     inProgress     | Executando
     blocked        | Nao Liberado
     pending        | Liberado        <-- ATENCAO

   `pending` NAO quer dizer pendente: quer dizer liberado para execucao. E
   `blocked` e o que esta travado. Ler esses dois ao contrario inverte o
   relatorio de producao da obra. */
create table if not exists setores (
  id             text primary key,
  pavimento_id   text not null references pavimentos(id) on delete cascade,
  nome           text not null default '',
  situacao       text not null default '' check (situacao in ('', 'executed', 'inProgress', 'blocked', 'pending')),
  pontos         text not null default '[]',
  area           real not null default 0,
  data_inicio    text,
  data_fim       text,
  material       text not null default '',
  sistema        text not null default '',
  custo_unitario real,
  atualizado_em  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em    text
);

create index if not exists idx_setores_pavimento on setores(pavimento_id);
create index if not exists idx_setores_sync on setores(atualizado_em);

/* ------------------------------------------------- historico de situacao */
/* Append-only de proposito: dois engenheiros marcando o mesmo setor na mesma
   visita nao se sobrescrevem, e a diretoria tem o rastro de quem mudou o que.
   Nunca recebe UPDATE nem DELETE. */
create table if not exists setor_situacao_log (
  id           text primary key,
  setor_id     text not null references setores(id) on delete cascade,
  situacao     text not null check (situacao in ('executed', 'inProgress', 'blocked', 'pending')),
  observacao   text not null default '',
  alterado_por text references usuarios(id),
  alterado_em  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_situacao_log_setor on setor_situacao_log(setor_id, alterado_em);

/* O historico e alimentado por gatilho, nao pelo codigo da aplicacao.

   Duas razoes. A primeira e custo: para saber se a situacao mudou, a aplicacao
   precisaria ler o setor antes de grava-lo — um SELECT por setor, e numa obra
   de 100 setores isso dobrava o numero de idas ao banco.

   A segunda e garantia: com a regra no banco, qualquer caminho que altere a
   situacao deixa rastro. Se amanha outra rota, uma correcao manual ou uma
   importacao mexer em `setores`, o historico continua completo — o que importa
   quando ele vale como prova de quem liberou o que, e quando. */
create trigger if not exists setor_situacao_inicial
after insert on setores
when new.situacao <> ''
begin
  insert into setor_situacao_log (id, setor_id, situacao, alterado_em)
  values (lower(hex(randomblob(16))), new.id, new.situacao, new.atualizado_em);
end;

create trigger if not exists setor_situacao_alterada
after update of situacao on setores
when new.situacao <> old.situacao and new.situacao <> ''
begin
  insert into setor_situacao_log (id, setor_id, situacao, alterado_em)
  values (lower(hex(randomblob(16))), new.id, new.situacao, new.atualizado_em);
end;

/* ----------------------------------------------- relatorios fotograficos */
/* `origem`: 'relatorio' e a visita cadastrada no dialogo; 'local' e o registro
   automatico por setor que o ensureLocalReport() cria no app. */
create table if not exists relatorios_foto (
  id            text primary key,
  obra_id       text not null references obras(id) on delete cascade,
  pavimento_id  text not null references pavimentos(id) on delete cascade,
  setor_id      text references setores(id) on delete set null,
  origem        text not null default 'relatorio' check (origem in ('relatorio', 'local')),
  descricao     text not null default '',
  data          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  autor_id      text references usuarios(id),
  atualizado_em text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em   text
);

create index if not exists idx_relatorios_obra on relatorios_foto(obra_id, data);
create index if not exists idx_relatorios_setor on relatorios_foto(setor_id);
create index if not exists idx_relatorios_sync on relatorios_foto(atualizado_em);

/* ------------------------------------------------------------------- fotos */
/* A tabela que faltava no diagrama. `r2_key` e o caminho do objeto no bucket;
   o binario nunca entra no D1. `largura`/`altura` evitam reflow na galeria. */
create table if not exists fotos (
  id            text primary key,
  relatorio_id  text not null references relatorios_foto(id) on delete cascade,
  r2_key        text not null unique,
  bytes         integer not null default 0,
  largura       integer not null default 0,
  altura        integer not null default 0,
  legenda       text not null default '',
  incluir_laudo integer not null default 1 check (incluir_laudo in (0, 1)),
  data          text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  autor_id      text references usuarios(id),
  atualizado_em text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em   text
);

create index if not exists idx_fotos_relatorio on fotos(relatorio_id, data);
create index if not exists idx_fotos_sync on fotos(atualizado_em);

/* ------------------------------------------------------------------ equipe */
create table if not exists funcionarios (
  id            text primary key,
  nome          text not null,
  matricula     text not null default '',
  funcao        text not null default '',
  empresa       text not null default '',
  telefone      text not null default '',
  situacao      text not null default 'ativo',
  criado_em     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em   text
);

create unique index if not exists idx_funcionarios_matricula
  on funcionarios(matricula) where matricula <> '' and excluido_em is null;
create index if not exists idx_funcionarios_sync on funcionarios(atualizado_em);

/* ---------------------------------------------------------------- presenca */
create table if not exists presenca (
  id             text primary key,
  funcionario_id text not null references funcionarios(id) on delete cascade,
  obra_id        text not null references obras(id) on delete cascade,
  entrada        text not null,
  saida          text,
  correcoes      text not null default '[]',
  criado_por     text references usuarios(id),
  criado_em      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  atualizado_em  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  excluido_em    text
);

create index if not exists idx_presenca_obra on presenca(obra_id, entrada);
create index if not exists idx_presenca_funcionario on presenca(funcionario_id, entrada);
create index if not exists idx_presenca_sync on presenca(atualizado_em);

/* -------------------------------------------------------------- atividades */
/* Equivalente ao historyKey do app. Append-only, como o log de situacao. */
create table if not exists atividades (
  id         text primary key,
  obra_id    text references obras(id) on delete set null,
  texto      text not null,
  detalhe    text not null default '',
  autor_id   text references usuarios(id),
  autor_nome text not null default '',
  data       text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists idx_atividades_data on atividades(data);

/* --------------------------------------------------------- armazenamento */
/* Contador de bytes gravados no R2, para o teto de 9,5 GB do plano gratuito.

   Existe para nao precisar de `select sum(bytes) from fotos` a cada upload: o
   SUM varre a tabela inteira, e o D1 cobra isso como linhas lidas. Com 40 mil
   fotos, cada envio gastaria 40 mil das 5 milhoes de leituras diarias — pouco
   mais de cem envios por dia. Esta tabela responde em uma linha.

   O valor e incrementado no envio, decrementado na exclusao e recalculado toda
   madrugada pelo cron, que corrige qualquer desvio acumulado. */
create table if not exists armazenamento (
  chave text primary key,
  valor integer not null default 0
);

insert or ignore into armazenamento (chave, valor) values ('r2_bytes', 0);

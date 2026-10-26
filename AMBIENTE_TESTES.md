# Painel NBZ — ambientes, acessos e publicação

Escrito para a equipe que opera e publica o painel de gestão de obras.

## Arquivos do projeto

| Arquivo | Função |
|---|---|
| `index.html` | A página e o JavaScript do painel. |
| `src/estilos/` | As folhas de estilo, numeradas: a ordem de carga é significativa. |
| `src/db.js`, `src/api.js`, `src/sincronizar.js` | Camada de mídia, cliente da API e fusão de dados. |
| `manifest.webmanifest` | Permite instalar o painel como aplicativo (PWA) no celular. |
| `sw.js` | Service worker: guarda os arquivos estáticos para abrir offline. |
| `src/worker/`, `src/schema.sql` | A API na Cloudflare e o banco. Não fazem parte da página. |
| `tests/` | Bateria automatizada, executada com `npm test`. Não vai para o ar. |

O `index.html` **não** funciona sozinho: sem `src/estilos/` ele abre sem formatação, e sem
os três arquivos de `src/` abre sem a camada de mídia nem o cliente da API. Publique a
pasta `src/` junto. O `manifest.webmanifest` e o `sw.js` só valem quando o painel é
servido por `http://` ou `https://`; abrindo o arquivo direto do disco são ignorados sem
erro.

## Ambiente de produção

- Endereço normal, sem parâmetros: `index.html`.
- Usa as chaves `nbz-gestao-obras-v1`, `nbz-gestao-historico-v1`, `nbz-usuarios-v1`,
  `nbz-preferencias-v1`, `nbz-funcionarios-v1` e `nbz-presenca-v1` do `localStorage`.

## Ambiente de testes

- Abra **`index.html?ambiente=teste`** (arquivo local ou domínio de desenvolvimento).
- A faixa laranja **AMBIENTE DE TESTES** identifica a sessão.
- Todas as chaves de armazenamento ganham o sufixo `-teste-v1`
  (`nbz-gestao-obras-teste-v1`, `nbz-usuarios-teste-v1`, e assim por diante).
- O ambiente de testes tem **usuários próprios**: no primeiro acesso ele pede a criação de
  um administrador separado. Nada do ambiente de testes é lido ou gravado em produção, e
  vice-versa.
- Dá para exercitar tudo: cargos, relatórios, fotografias, plantas, demarcações e troca de
  situação das áreas.
- Remover `?ambiente=teste` volta ao ambiente normal.

Recomendação: use um perfil do navegador separado para os testes e não limpe os dados do
site no perfil de produção.

## Primeiro acesso e cargos

No primeiro acesso de cada ambiente o painel pede o cadastro do administrador (nome,
usuário e senha de no mínimo 8 caracteres). **Nenhuma senha padrão é distribuída no
código.** Depois disso, o administrador cadastra os demais usuários em **Usuários**, na
barra superior.

| Cargo | Painel | Obras | Equipe | Relatórios | Histórico | Edita obras/plantas | Exclui | Fotos | Situação | Presença | Cadastro de equipe | Usuários |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Administrador | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Engenheiro / Coordenador | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| Encarregado de obra | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | ✔ | ✔ | ✔ | — | — |
| Técnico de campo | ✔ | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ | ✔ | — | — |
| Cliente / Visualização | ✔ | — | — | ✔ | — | — | — | — | — | — | — | — |

A interface se adapta ao cargo: menus, botões e ações que o usuário não pode usar não
aparecem. As mesmas regras são verificadas de novo em cada ponto de gravação de dados,
então não basta reexibir um botão pelo inspetor do navegador para alterar informação.

Para incluir um cargo novo, acrescente uma entrada em `roleDefinitions`, dentro de
`index.html`, com a lista de permissões desejada: `dashboard`, `works`, `team`,
`reports`, `history`, `works.create`, `works.edit`, `works.delete`, `photos.edit`,
`regions.edit`, `status.edit`, `attendance.edit`, `team.manage`, `history.clear`,
`users.manage`. O resto da interface se ajusta sozinho.

## Equipe: presença e cadastro geral

A aba **Equipe** tem duas seções.

**Presença na obra** — escolha a obra e registre entrada ou saída de cada funcionário com
um toque. A data e a hora são gravadas automaticamente, junto com o nome de quem lançou.
Quem está presente aparece destacado em verde, com o tempo decorrido. Filtros por
situação, nome/matrícula, período e funcionário. O histórico permite **corrigir** um
registro errado: a correção exige um motivo e guarda o valor anterior e o novo, sem apagar
nada.

Regras aplicadas: não é possível lançar duas entradas para o mesmo funcionário, nem
mantê-lo presente em duas obras ao mesmo tempo; funcionário inativo não recebe entrada
nova, mas o histórico dele continua disponível.

**Cadastro geral** — nome completo (obrigatório), matrícula, função, empresa, telefone e
situação (ativo/inativo), com busca por nome ou matrícula. O botão **Importar funcionários
do Excel** aceita `.xlsx`, `.xls` e `.csv`:

1. Baixe o modelo pelo botão **Baixar modelo de planilha**.
2. Escolha o arquivo: o sistema lê, valida e mostra uma **prévia** com o que será
   cadastrado, atualizado ou ignorado, e o motivo de cada linha ignorada.
3. Nada é gravado até você confirmar; atualizações de cadastros existentes ainda pedem uma
   confirmação à parte.
4. No fim, um resumo informa quantos foram cadastrados, atualizados e ignorados.

A matrícula é o identificador principal. Sem matrícula, a comparação usa nome + empresa.
Cadastros existentes nunca são substituídos ou excluídos em silêncio. A leitura de `.xlsx`
usa uma biblioteca carregada da internet; sem conexão, o sistema avisa e continua
aceitando `.csv` (e o modelo é baixado em `.csv`). Funcionários com presença registrada
não podem ser excluídos — marque-os como inativos para preservar o histórico.

## Sessão e histórico protegido

- A sessão fica na aba do navegador (`sessionStorage`). Após **10 minutos** sem interação
  (clique, toque, movimento do mouse, digitação ou rolagem) aparece um aviso de sessão
  inativa com contagem de 60 segundos e a opção **Continuar usando o sistema**. Sem
  resposta, a sessão é bloqueada e volta à tela de login; tudo o que já foi salvo
  permanece gravado. Enquanto houver foto sendo comprimida, planilha sendo importada ou
  gravação em andamento, o bloqueio é adiado até a operação terminar.
- O **Histórico** exige que o usuário confirme a própria senha, mesmo já estando logado. O
  acesso vale **10 minutos** e depois volta a pedir a senha.
- Cinco tentativas erradas bloqueiam o login ou o histórico por **5 minutos**.
- As senhas são guardadas apenas como hash PBKDF2-SHA256 (150 000 iterações) com sal
  individual. Em navegadores sem `crypto.subtle`, o sistema cai para um hash interno mais
  fraco — use navegadores atuais.
- O hash gravado carrega o nome do algoritmo usado (`pbkdf2$…` ou `fallback$…`) e a
  conferência sempre usa esse algoritmo, não o que estiver disponível no momento. Assim uma
  senha criada em navegador antigo continua funcionando em navegador atual, e vice-versa.
- Se o navegador não tiver o recurso de criptografia necessário para conferir a senha
  gravada, o painel diz isso em vez de "usuário ou senha inválidos" e **não** gasta uma das
  cinco tentativas — uma limitação do navegador não bloqueia a conta. `crypto.subtle` existe
  em `https://` e em `localhost`, mas não em `http://` comum nem em arquivo aberto do disco.
- Acessos, liberações de histórico, tentativas recusadas e alterações de cargo ficam
  registrados no próprio histórico, com o nome do responsável.

## Instalar no celular (PWA)

Com o painel publicado em `https://`, o Chrome (Android) e o Safari (iPhone) oferecem
"Adicionar à tela de início". Instalado, ele abre em tela cheia e continua funcionando sem
rede, porque o `sw.js` guarda os arquivos estáticos. Os dados continuam no navegador do
aparelho — a instalação não sincroniza nada entre dispositivos.

## Planta, cores dos ambientes e relatório em A4

### As quatro situações

| Situação | Cor | Valor gravado |
|---|---|---|
| Finalizado | verde | `executed` |
| Executando | azul | `inProgress` |
| Não Liberado | vermelho | `blocked` |
| Liberado | amarelo | `pending` |

Os rótulos e as cores mudaram, mas **o valor gravado é o mesmo de antes** — nenhum dado
precisou ser convertido, e plantas marcadas na versão anterior continuam válidas. Para
mexer em rótulo, cor ou ordem, edite `regionStatusOptions` em `index.html`: a barra da
planta, o painel do local, o resumo do pavimento e o relatório saem todos de lá.

### A barra da planta

Na planta de um pavimento (**Obras → abrir obra → Abrir planta**) uma única barra no topo
reúne tudo. Nada do que se usa no dia a dia fica abaixo da planta.

| Botão | O que faz ao tocar numa área |
|---|---|
| **Finalizado / Executando / Não Liberado / Liberado** | pinta a área com aquela cor |
| **Demarcar Áreas** | entra no desenho: arraste para criar a área |
| **Fotos** | abre **Dados do setor** — fotografias, situação e exclusão |

**Trocar a cor de uma área é um clique.** Com uma cor escolhida no topo, tocar na área já
aplica. E se a área já estiver selecionada, tocar numa cor no topo aplica nela na hora,
sem precisar tocar na área de novo.

A seleção é **automática**: tocar numa área a seleciona. Não existe botão "Selecionar
área" — nem "Aplicar situação", que as cores do topo substituíram.

A cor ativa fica marcada por um anel na própria cor e um **✓** dentro do quadrado, e o
rótulo acima da barra diz por extenso o que está valendo. Tocar numa área que já está
naquela cor avisa, em vez de não responder. Cada toque muda apenas a área tocada, e quem
não tem a permissão `status.edit` recebe o aviso de permissão em vez de pintar.

Enquanto **Demarcar Áreas** está ativo, aparece logo abaixo a fileira com *Desfazer
ponto*, *Concluir polígono* e *Limpar pavimento* — e some quando se sai do desenho.

Para **mover ou redimensionar** uma área, use o modo **Fotos** (sem cor escolhida):
arraste o interior para mover e os cantos para redimensionar. Com uma cor escolhida o
toque é só para pintar, de propósito — assim um tremor no dedo não sai arrastando a
demarcação.

### Dados do setor

É o painel que abre ao tocar numa área no modo **Fotos**. Reúne o que é específico de um
setor:

- as **fotografias** do local, que alimentam o relatório;
- a **situação**, nas mesmas quatro cores da barra do topo;
- **Editar dados do setor** (nome, área, sistema, material, datas, custo);
- **Excluir área**.

Excluir e trocar a situação ficam aqui, e não na barra da planta, para que a barra guarde
só o que se usa a cada toque.

### Lista de pavimentos

Em **Obras → abrir obra → Pavimentos**, cada pavimento é um cartão com identificação,
área total, barra de progresso, a contagem `% · N setor(es)` e as ações **Replicar** e
**Excluir**. O cartão inteiro abre a planta.

O cartão **não** repete os botões de situação de cada setor. Eles alongavam a lista — oito
pavimentos com dois setores cada rendiam 64 botões — e empurravam para fora da tela o que
a lista existe para mostrar. A situação de um setor se altera em dois lugares:

- **Na planta**, pela paleta de cores: um toque na cor, um toque no ambiente.
- **No painel do local**, aberto ao tocar num setor dentro da planta (com o pincel
  desligado), que usa as mesmas cores da paleta e mostra as fotografias e os dados do
  setor.

### Relatório em folha A4

Em **Relatórios**, o botão **⤓ Imprimir** monta a folha e abre a impressão do navegador.
A folha é A4 retrato com margens de 12 mm em cima e embaixo e 10 mm nas laterais.

O que muda em relação à tela:

- A **planta** ocupa a largura inteira da coluna (até 150 mm de altura), em vez da
  miniatura usada na tela.
- As **fotografias** saem **duas por linha** (cerca de 88 mm cada), com a altura livre —
  uma foto em retrato continua em retrato e uma em paisagem continua em paisagem, sem
  corte nem deformação. A legenda (data e autor) vai **abaixo** de cada foto.
- A folha leva **todas** as fotografias de cada visita. Na tela a galeria mostra só as 6
  primeiras, com o botão "+N foto(s)"; na impressão esse limite não se aplica.
- Pavimentos **recolhidos** na tela saem **abertos** no papel.
- A tabela de setores sai inteira, e o cabeçalho dela **se repete** quando ela atravessa
  mais de uma página.
- A folha ganha um **cabeçalho próprio** com o título, a obra filtrada e a data e hora de
  geração — na tela essas informações ficam na barra de ferramentas, que não é impressa.
- Botões, filtros e controles de tela não são impressos.

Fundos coloridos não são usados na folha: o navegador só imprime fundo quando a opção
"Gráficos de segundo plano" está ligada, e sem ela um texto branco sairia invisível. Os
indicadores em que a cor **é** a informação (chips de situação, barras de progresso) são
marcados para sair coloridos de qualquer forma.

Imagens grandes podem passar para a página seguinte em vez de serem cortadas ao meio —
isso é esperado e mantém a folha limpa.

## Bateria automatizada de testes

O painel roda inteiramente no navegador, mas a bateria pode ser executada no terminal: ela
carrega o próprio `index.html` num navegador simulado (jsdom) e dirige a interface de
verdade — preenche campos, envia formulários e confere o que ficou gravado.

```bash
npm install     # só na primeira vez
npm test
```

São 47 verificações. Leva alguns minutos, porque usa o PBKDF2 real de 150 000 iterações em
vez de um substituto rápido — testar o algoritmo de mentira esconderia justamente os
defeitos de senha.

| Arquivo | Função |
|---|---|
| `tests/harness.js` | Sobe o painel em jsdom e oferece os atalhos (criar administrador, entrar, simular cota cheia). |
| `tests/painel.test.js` | As verificações. |

O que a bateria cobre: primeiro acesso e login, bloqueio após cinco tentativas, isolamento
do ambiente de testes, permissões por cargo, situação das áreas e soma por situação, regras
de presença, leitura de planilha (`;`, `,`, aspas, BOM, CRLF), classificação da importação,
área e geometria das demarcações, conversão dos pavimentos antigos, o comportamento do
painel quando o armazenamento do navegador está cheio, a paleta de cores dos ambientes e o
conteúdo da folha de impressão (todas as fotos, pavimentos abertos, imagens carregadas,
cabeçalho com obra e data).

O que ela **não** cobre, e continua exigindo revisão no navegador: desenho e arraste das
demarcações com o dedo ou o mouse, pinça para ampliar, importação de plantas em PDF,
câmera, compressão de fotografias e a instalação como aplicativo.

O **layout** da folha A4 também não é medido pela bateria — o jsdom não calcula impressão.
A bateria garante o conteúdo e as regras de CSS; o tamanho real das imagens na página se
confere pela pré-visualização de impressão do navegador (**Relatórios → ⤓ Imprimir**, ou
Ctrl+P), com a opção de papel em A4.

### Conferir que um teste de correção realmente pega o defeito

Um teste escrito para um bug só vale se falhar na versão que tinha o bug. `NBZ_INDEX`
aponta a bateria para outra cópia do painel:

```bash
NBZ_INDEX=/caminho/para/index.html.anterior node tests/painel.test.js
```

As verificações de correção devem falhar nessa cópia e passar na atual.

## Publicação de uma versão aprovada

1. Rode `npm test` e confirme que as 22 verificações passam.
2. Revise a versão em `index.html?ambiente=teste`, passando pelos fluxos de cargos,
   relatórios, fotografias, demarcações e troca de situação — inclusive o que a bateria
   automatizada não alcança (desenho das demarcações, plantas em PDF, câmera).
3. Guarde uma cópia dos arquivos atualmente hospedados (`index.html`,
   `manifest.webmanifest`, `sw.js` e a pasta `src/`).
4. Publique esses arquivos no ambiente de produção pela rotina de hospedagem do projeto.
   Esquecer `src/` publica um painel sem formatação e sem sincronização.
5. Ao acrescentar ou renomear arquivo estático, atualize a lista `precache` do `sw.js`.
   Trocar o `cacheName` não é mais necessário para o conteúdo mudar: o service worker
   busca na rede primeiro o que é nosso, e só usa o cache quando não há rede.
6. Abra o endereço normal (sem `?ambiente=teste`) e confira uma leitura e uma edição
   controlada.

Este repositório não contém pipeline de deploy, servidor, API nem banco de dados
conectado: a publicação segue o processo já usado pela equipe de hospedagem.

## Dados, cópias de segurança e migração

- Obras, pavimentos, demarcações, fotografias, histórico, usuários, funcionários e
  registros de presença ficam no `localStorage` do navegador. Não há servidor nem
  sincronização entre aparelhos: o que é lançado no celular do encarregado não aparece
  no computador do escritório.
- As fotografias são redimensionadas (máx. 1600 px no lado maior) e recomprimidas em JPEG
  antes de serem gravadas. Mesmo assim o `localStorage` tem limite de poucos megabytes por
  site: quando a gravação falha, o painel avisa, desfaz a alteração e mostra "alterações não
  gravadas" na barra superior.
- Cada gravação é feita por inteiro ou não é feita. O painel grava duas chaves em sequência
  (obras + histórico, ou cadastro de equipe + presença) e o `localStorage` não tem
  transação; por isso ele guarda o conteúdo anterior das duas chaves e o restaura se
  qualquer uma falhar. É o que garante que a mensagem "o valor anterior foi mantido"
  descreva também o que está gravado, e não apenas o que está na tela.
- O histórico guarda as 150 atividades mais recentes. O corte é aplicado **antes** de
  gravar, então um histórico grande consegue encolher e gravar num armazenamento quase
  cheio, em vez de deixar o painel preso em "alterações não gravadas".
- Na primeira abertura após esta atualização, os pavimentos antigos que tinham
  comprimento e largura são convertidos para **área total** (área = comprimento × largura)
  e os campos antigos são removidos. Antes de converter, o painel grava uma cópia integral
  dos dados anteriores na chave `nbz-gestao-obras-v1-backup-pre-area`
  (`...-teste-v1-backup-pre-area` no ambiente de testes). Para restaurar manualmente, copie
  o conteúdo dessa chave de volta para `nbz-gestao-obras-v1`.

## Limites de segurança desta arquitetura

Esta é uma aplicação estática: não existe servidor nem API para validar nada.

- Cargos, bloqueio de URLs e senha do histórico **controlam a aplicação**, inclusive as
  chamadas diretas às funções internas de gravação, mas quem tiver acesso ao aparelho pode
  ler ou alterar o `localStorage` pelas ferramentas do navegador. Isso **não** é uma
  fronteira de segurança contra o próprio usuário da máquina.
- O ambiente de testes separa os dados por chave, o que evita mistura acidental, mas
  também não é barreira contra alteração deliberada.
- Para que cargos, bloqueio de histórico e isolamento de ambientes valham como garantia de
  segurança, é preciso autenticação e autorização em servidor, persistência central e
  armazenamento de credenciais no servidor. Nenhum desses componentes existe neste projeto.

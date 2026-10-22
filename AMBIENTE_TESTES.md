# Painel NBZ — ambientes, acessos e publicação

Escrito para a equipe que opera e publica o painel de gestão de obras.

## Arquivos do projeto

| Arquivo | Função |
|---|---|
| `index.html` | A aplicação inteira (HTML, CSS e JavaScript embutidos). |
| `manifest.webmanifest` | Permite instalar o painel como aplicativo (PWA) no celular. |
| `sw.js` | Service worker: guarda os arquivos estáticos para abrir offline. |

`index.html` funciona sozinho. Os dois últimos arquivos só são usados quando o painel é
servido por `http://` ou `https://`; abrindo o arquivo direto do disco eles são ignorados
sem erro.

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
- Acessos, liberações de histórico, tentativas recusadas e alterações de cargo ficam
  registrados no próprio histórico, com o nome do responsável.

## Instalar no celular (PWA)

Com o painel publicado em `https://`, o Chrome (Android) e o Safari (iPhone) oferecem
"Adicionar à tela de início". Instalado, ele abre em tela cheia e continua funcionando sem
rede, porque o `sw.js` guarda os arquivos estáticos. Os dados continuam no navegador do
aparelho — a instalação não sincroniza nada entre dispositivos.

## Publicação de uma versão aprovada

1. Revise a versão em `index.html?ambiente=teste`, passando pelos fluxos de cargos,
   relatórios, fotografias, demarcações e troca de situação.
2. Guarde uma cópia dos arquivos atualmente hospedados (`index.html`, `manifest.webmanifest`,
   `sw.js`).
3. Publique os três arquivos no ambiente de produção pela rotina de hospedagem do projeto.
4. Ao mudar `index.html`, incremente `cacheName` em `sw.js` (por exemplo `nbz-obras-v2`)
   para que os aparelhos já instalados troquem o cache antigo.
5. Abra o endereço normal (sem `?ambiente=teste`) e confira uma leitura e uma edição
   controlada.

Este repositório não contém pipeline de deploy, servidor, API nem banco de dados
conectado: a publicação segue o processo já usado pela equipe de hospedagem.

## Dados, cópias de segurança e migração

- Obras, pavimentos, demarcações, fotografias, histórico, usuários, funcionários e
  registros de presença ficam no `localStorage` do navegador. Não há servidor nem
  sincronização entre aparelhos: o que é lançado no celular do encarregado não aparece
  no computador do escritório.
- As fotografias são redimensionadas (máx. 1280 px) e recomprimidas em JPEG antes de serem
  gravadas. Mesmo assim o `localStorage` tem limite de poucos megabytes por site: quando a
  gravação falha, o painel avisa, desfaz a alteração e mostra "alterações não gravadas" na
  barra superior.
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

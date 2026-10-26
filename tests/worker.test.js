/* Testes do Worker NBZ: login, sessao, trava e permissoes.

   Rode com `npm run test:worker`.

   O D1 e o SQLite do Cloudflare, e o `node:sqlite` e o mesmo motor. O adaptador
   abaixo traduz a API do D1 (`prepare().bind().first()`) para a do node:sqlite,
   o que permite exercitar as consultas de verdade — inclusive as restricoes de
   unicidade e os CHECK do schema — sem subir nada na nuvem.

   O que NAO se cobre aqui: comportamento do R2 e limite de CPU do Worker. O
   primeiro precisa de `wrangler dev`; o segundo so aparece em producao.
*/
import { adaptarD1, bancoNovo } from './d1-memoria.mjs';
import { teste, confirmar, igual, executar } from './harness.js';
import { autenticar, desafio, login, minutosDeTrava, trocarSenha } from '../src/worker/auth.js';
import * as usuarios from '../src/worker/usuarios.js';
import { iguaisEmTempoConstante, novoSalt, paraHex } from '../src/worker/cripto.js';


function montarAmbiente() {
  const db = bancoNovo();
  return { DB: adaptarD1(db), PEPPER: 'pepper-de-teste-nao-usar-em-producao', ORIGENS: '' };
}

/* Pedido falso com o minimo que o Worker le dos cabecalhos. */
function pedidoFalso({ token = '', ip = '203.0.113.7', agente = 'teste' } = {}) {
  const cabecalhos = new Map([['cf-connecting-ip', ip], ['user-agent', agente]]);
  if (token) cabecalhos.set('authorization', `Bearer ${token}`);
  return { headers: { get: (nome) => cabecalhos.get(String(nome).toLowerCase()) || null } };
}

/* ------------------------------------------------- PBKDF2 do lado cliente */

/* Reproduz o que o navegador faz antes de chamar a API. Iteracoes baixas de
   proposito: aqui se testa o protocolo, nao o custo do KDF, e 210 mil
   iteracoes por caso deixariam a suite lenta sem cobrir nada a mais. */
async function clientHash(senha, salt, iteracoes = 1000) {
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: iteracoes },
    chave, 256
  );
  return paraHex(bits);
}

/* Cria o administrador inicial e devolve a sessao dele, que e o ponto de
   partida de quase todo caso. */
async function comAdministrador(env, { senha = 'senhaforte1' } = {}) {
  const salt = novoSalt();
  const resultado = await usuarios.primeiroAdministrador(env, {
    nome: 'André Mendonça', usuario: 'andre', email: 'andre@nbzimper.com.br',
    clientHash: await clientHash(senha, salt), salt
  });
  confirmar(!resultado.erro, `setup deveria funcionar: ${resultado.erro || ''}`);
  const entrada = await login(env, {
    usuario: 'andre', clientHash: await clientHash(senha, salt)
  }, pedidoFalso());
  confirmar(entrada.token, `login do admin deveria funcionar: ${entrada.erro || ''}`);
  return { token: entrada.token, usuario: resultado.usuario, salt };
}

/* ------------------------------------------------------------------ casos */

teste('o primeiro administrador é criado uma vez e a rota se fecha depois', async () => {
  const env = montarAmbiente();
  await comAdministrador(env);

  const salt = novoSalt();
  const segunda = await usuarios.primeiroAdministrador(env, {
    nome: 'Invasor', usuario: 'invasor', clientHash: await clientHash('outrasenha1', salt), salt
  });
  igual(segunda.status, 409, 'a segunda chamada deveria ser recusada');
  confirmar(/já tem administrador/.test(segunda.erro), 'deveria explicar que já existe administrador');
});

teste('não existe autocadastro: quem não tem conta não consegue criar uma', async () => {
  const env = montarAmbiente();
  await comAdministrador(env);
  /* Sem sessao, `cadastrar` recebe null e tem de recusar — e a unica porta
     para usuario novo depois do setup. */
  const tentativa = await usuarios.cadastrar(env, null, {
    nome: 'Estranho', usuario: 'estranho', nivelAcesso: 'administrador'
  });
  igual(tentativa.status, 403, 'sem sessão o cadastro deveria ser proibido');
});

teste('o administrador cadastra alguém e essa pessoa entra', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessaoAdmin = await autenticar(env, pedidoFalso({ token: admin.token }));

  const salt = novoSalt();
  const criado = await usuarios.cadastrar(env, sessaoAdmin, {
    nome: 'Richard Henrique', usuario: 'richard', email: 'richard@nbzimper.com.br',
    nivelAcesso: 'engenheiro', clientHash: await clientHash('provisoria1', salt), salt
  });
  confirmar(!criado.erro, `o cadastro deveria funcionar: ${criado.erro || ''}`);
  igual(criado.usuario.nivelAcesso, 'engenheiro', 'o cargo deveria ter sido gravado');
  igual(criado.usuario.precisaTrocarSenha, true, 'a senha provisória deveria exigir troca');

  const entrada = await login(env, {
    usuario: 'richard', clientHash: await clientHash('provisoria1', salt)
  }, pedidoFalso());
  confirmar(entrada.token, `a pessoa cadastrada deveria entrar: ${entrada.erro || ''}`);
  igual(entrada.usuario.precisaTrocarSenha, true, 'o primeiro login deveria pedir troca de senha');
});

teste('a senha que o administrador define pode valer definitivamente', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessaoAdmin = await autenticar(env, pedidoFalso({ token: admin.token }));

  /* `exigirTrocaDeSenha: false` é o caso em que a pessoa entra sempre com a
     senha que o administrador criou, sem passar por troca obrigatória. */
  const salt = novoSalt();
  const criado = await usuarios.cadastrar(env, sessaoAdmin, {
    nome: 'Richard Henrique', usuario: 'richard', nivelAcesso: 'engenheiro',
    clientHash: await clientHash('senhadorichard1', salt), salt,
    exigirTrocaDeSenha: false
  });
  igual(criado.usuario.precisaTrocarSenha, false, 'não deveria exigir troca');

  const entrada = await login(env, {
    usuario: 'richard', clientHash: await clientHash('senhadorichard1', salt)
  }, pedidoFalso());
  confirmar(entrada.token, `deveria entrar com a senha do administrador: ${entrada.erro || ''}`);
  igual(entrada.usuario.precisaTrocarSenha, false, 'e entrar direto, sem tela de troca');

  /* E a sessão abre normalmente, sem o 428 que barra senha provisória. */
  const sessao = await autenticar(env, pedidoFalso({ token: entrada.token }));
  confirmar(sessao && !sessao.precisaTrocarSenha, 'a sessão deveria estar liberada');
});

teste('engenheiro não cadastra usuário, mesmo chamando a rota direto', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessaoAdmin = await autenticar(env, pedidoFalso({ token: admin.token }));

  const salt = novoSalt();
  await usuarios.cadastrar(env, sessaoAdmin, {
    nome: 'Richard', usuario: 'richard', nivelAcesso: 'engenheiro',
    clientHash: await clientHash('provisoria1', salt), salt
  });
  const entrada = await login(env, {
    usuario: 'richard', clientHash: await clientHash('provisoria1', salt)
  }, pedidoFalso());
  const sessaoEng = await autenticar(env, pedidoFalso({ token: entrada.token }));

  const outroSalt = novoSalt();
  const tentativa = await usuarios.cadastrar(env, sessaoEng, {
    nome: 'Terceiro', usuario: 'terceiro', nivelAcesso: 'administrador',
    clientHash: await clientHash('senha12345', outroSalt), salt: outroSalt
  });
  igual(tentativa.status, 403, 'engenheiro deveria receber 403');

  /* E a lista também não vaza quem trabalha na empresa. */
  const lista = await usuarios.listar(env, sessaoEng);
  igual(lista.usuarios.length, 1, 'engenheiro deveria ver só a própria conta');
  igual(lista.usuarios[0].usuario, 'richard', 'e a conta deveria ser a dele');
});

teste('senha errada não entra e a mensagem não revela se o usuário existe', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);

  const errada = await login(env, {
    usuario: 'andre', clientHash: await clientHash('senhaerrada1', admin.salt)
  }, pedidoFalso());
  confirmar(!errada.token, 'não deveria devolver token');
  igual(errada.status, 401, 'deveria responder 401');

  const inexistente = await login(env, {
    usuario: 'ninguem', clientHash: await clientHash('qualquer1', novoSalt())
  }, pedidoFalso());
  igual(inexistente.status, 401, 'usuário inexistente também deveria dar 401');
  /* As duas mensagens começam igual: a diferença entre "não existe" e "senha
     errada" permitiria enumerar quem tem conta. */
  confirmar(
    errada.erro.startsWith('Usuário ou senha inválidos') &&
    inexistente.erro.startsWith('Usuário ou senha inválidos'),
    'as duas respostas deveriam usar a mesma mensagem'
  );
});

teste('o desafio devolve salt estável para quem não existe', async () => {
  const env = montarAmbiente();
  await comAdministrador(env);

  const real = await desafio(env, { usuario: 'andre' });
  confirmar(/^[0-9a-f]{32}$/.test(real.salt), 'o salt real deveria ser hex de 32 caracteres');

  const fachada1 = await desafio(env, { usuario: 'ninguem' });
  const fachada2 = await desafio(env, { usuario: 'ninguem' });
  confirmar(/^[0-9a-f]{32}$/.test(fachada1.salt), 'o salt de fachada deveria ter o mesmo formato');
  igual(fachada2.salt, fachada1.salt, 'o salt de fachada deveria ser estável entre chamadas');
  confirmar(fachada1.salt !== real.salt, 'a fachada não deveria coincidir com um salt real');
});

teste('cinco tentativas erradas travam a conta no servidor', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const hashErrado = await clientHash('naoehasenha1', admin.salt);

  for (let i = 0; i < 5; i += 1) {
    await login(env, { usuario: 'andre', clientHash: hashErrado }, pedidoFalso());
  }
  confirmar(await minutosDeTrava(env, 'andre') > 0, 'a conta deveria estar travada');

  /* E a senha CORRETA também é recusada enquanto a trava vale — é isso que
     impede a força bruta de continuar. */
  const certa = await login(env, {
    usuario: 'andre', clientHash: await clientHash('senhaforte1', admin.salt)
  }, pedidoFalso());
  igual(certa.status, 429, 'deveria responder 429 mesmo com a senha certa');
  confirmar(!certa.token, 'não deveria devolver token durante a trava');
});

teste('login bom zera as falhas anteriores', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);

  for (let i = 0; i < 4; i += 1) {
    await login(env, {
      usuario: 'andre', clientHash: await clientHash('errada1', admin.salt)
    }, pedidoFalso());
  }
  const certa = await login(env, {
    usuario: 'andre', clientHash: await clientHash('senhaforte1', admin.salt)
  }, pedidoFalso());
  confirmar(certa.token, 'com 4 falhas a senha certa ainda deveria entrar');
  igual(await minutosDeTrava(env, 'andre'), 0, 'as falhas deveriam ter sido zeradas');
});

teste('token inválido ou ausente não abre sessão', async () => {
  const env = montarAmbiente();
  await comAdministrador(env);

  igual(await autenticar(env, pedidoFalso()), null, 'sem token');
  igual(await autenticar(env, pedidoFalso({ token: 'inventado' })), null, 'token inventado');
  igual(await autenticar(env, pedidoFalso({ token: '0'.repeat(64) })), null, 'token com formato plausível');
});

teste('trocar a senha derruba as sessões abertas', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessao = await autenticar(env, pedidoFalso({ token: admin.token }));
  confirmar(sessao, 'a sessão deveria estar válida antes da troca');

  const novoSaltSenha = novoSalt();
  const troca = await trocarSenha(env, sessao, {
    clientHashAtual: await clientHash('senhaforte1', admin.salt),
    novoClientHash: await clientHash('novasenha123', novoSaltSenha),
    novoSalt: novoSaltSenha
  });
  confirmar(!troca.erro, `a troca deveria funcionar: ${troca.erro || ''}`);

  igual(await autenticar(env, pedidoFalso({ token: admin.token })), null,
    'o token antigo deveria ter sido invalidado');

  const reentrada = await login(env, {
    usuario: 'andre', clientHash: await clientHash('novasenha123', novoSaltSenha)
  }, pedidoFalso());
  confirmar(reentrada.token, 'a senha nova deveria entrar');
  igual(reentrada.usuario.precisaTrocarSenha, false, 'a obrigação de trocar deveria ter saído');
});

teste('a senha crua é recusada no lugar do hash', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  /* Se o painel mandasse a senha em texto por engano, ela não pode ser aceita
     nem gravada como se fosse hash. */
  const tentativa = await login(env, { usuario: 'andre', clientHash: 'senhaforte1' }, pedidoFalso());
  igual(tentativa.status, 401, 'senha crua deveria ser recusada');

  const sessao = await autenticar(env, pedidoFalso({ token: admin.token }));
  const troca = await trocarSenha(env, sessao, {
    clientHashAtual: 'senhaforte1', novoClientHash: 'outrasenha', novoSalt: novoSalt()
  });
  igual(troca.status, 400, 'a troca deveria recusar formato inválido');
});

teste('o único administrador não pode se rebaixar nem ser excluído', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessao = await autenticar(env, pedidoFalso({ token: admin.token }));

  const rebaixar = await usuarios.editar(env, sessao, admin.usuario.id, { nivelAcesso: 'engenheiro' });
  igual(rebaixar.status, 409, 'rebaixar o único administrador deveria ser recusado');

  const desativar = await usuarios.editar(env, sessao, admin.usuario.id, { ativo: false });
  igual(desativar.status, 409, 'desativar o único administrador deveria ser recusado');

  const excluir = await usuarios.excluir(env, sessao, admin.usuario.id);
  igual(excluir.status, 409, 'excluir a própria conta deveria ser recusado');
});

teste('desativar alguém derruba a sessão dele na hora', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessaoAdmin = await autenticar(env, pedidoFalso({ token: admin.token }));

  const salt = novoSalt();
  const criado = await usuarios.cadastrar(env, sessaoAdmin, {
    nome: 'Richard', usuario: 'richard', nivelAcesso: 'engenheiro',
    clientHash: await clientHash('provisoria1', salt), salt
  });
  const entrada = await login(env, {
    usuario: 'richard', clientHash: await clientHash('provisoria1', salt)
  }, pedidoFalso());
  confirmar(await autenticar(env, pedidoFalso({ token: entrada.token })), 'a sessão deveria valer');

  await usuarios.editar(env, sessaoAdmin, criado.usuario.id, { ativo: false });
  igual(await autenticar(env, pedidoFalso({ token: entrada.token })), null,
    'depois de desativado o token não deveria mais valer');

  const reentrada = await login(env, {
    usuario: 'richard', clientHash: await clientHash('provisoria1', salt)
  }, pedidoFalso());
  igual(reentrada.status, 401, 'desativado não deveria conseguir entrar de novo');
});

teste('usuário repetido é recusado', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessao = await autenticar(env, pedidoFalso({ token: admin.token }));

  const salt = novoSalt();
  const dados = {
    nome: 'Outro André', usuario: 'andre', nivelAcesso: 'engenheiro',
    clientHash: await clientHash('provisoria1', salt), salt
  };
  const repetido = await usuarios.cadastrar(env, sessao, dados);
  igual(repetido.status, 409, 'usuário já existente deveria dar 409');
});

teste('os cinco cargos do painel são aceitos, e só eles', async () => {
  const env = montarAmbiente();
  const admin = await comAdministrador(env);
  const sessao = await autenticar(env, pedidoFalso({ token: admin.token }));

  /* A lista tem de ser a mesma de `roleDefinitions` no index.html: cargo que o
     servidor aceita mas a interface não conhece cairia em 'cliente' no
     `roleOf()`, dando a alguém menos acesso do que foi cadastrado. */
  const cargos = ['engenheiro', 'encarregado', 'tecnico', 'cliente'];
  for (const cargo of cargos) {
    const salt = novoSalt();
    const criado = await usuarios.cadastrar(env, sessao, {
      nome: `Pessoa ${cargo}`, usuario: `user-${cargo}`, nivelAcesso: cargo,
      clientHash: await clientHash('provisoria1', salt), salt
    });
    confirmar(!criado.erro, `o cargo "${cargo}" deveria ser aceito: ${criado.erro || ''}`);
    igual(criado.usuario.nivelAcesso, cargo, `o cargo gravado deveria ser "${cargo}"`);
  }

  /* 'diretoria' vinha do diagrama inicial e nunca existiu no painel. */
  const salt = novoSalt();
  const invalido = await usuarios.cadastrar(env, sessao, {
    nome: 'Alguém', usuario: 'alguem', nivelAcesso: 'diretoria',
    clientHash: await clientHash('provisoria1', salt), salt
  });
  igual(invalido.status, 400, 'cargo fora da lista do painel deveria ser recusado');
});

teste('encarregado e técnico podem enviar fotografia; cliente não', async () => {
  /* `photos.edit` pertence a quatro dos cinco cargos no index.html. Barrar
     encarregado e técnico no servidor impediria justamente quem faz a vistoria
     em campo de registrar a foto. */
  const { podeEnviarFoto } = await import('../src/worker/fotos.js')
    .then((modulo) => ({ podeEnviarFoto: modulo.podeEnviarFoto }));

  igual(podeEnviarFoto({ nivelAcesso: 'administrador' }), true, 'administrador');
  igual(podeEnviarFoto({ nivelAcesso: 'engenheiro' }), true, 'engenheiro');
  igual(podeEnviarFoto({ nivelAcesso: 'encarregado' }), true, 'encarregado');
  igual(podeEnviarFoto({ nivelAcesso: 'tecnico' }), true, 'técnico');
  igual(podeEnviarFoto({ nivelAcesso: 'cliente' }), false, 'cliente só visualiza');
});

teste('a comparação de tempo constante distingue valores corretamente', async () => {
  confirmar(iguaisEmTempoConstante('abc', 'abc'), 'iguais deveriam bater');
  confirmar(!iguaisEmTempoConstante('abc', 'abd'), 'diferentes no fim não deveriam bater');
  confirmar(!iguaisEmTempoConstante('abc', 'xbc'), 'diferentes no início não deveriam bater');
  confirmar(!iguaisEmTempoConstante('abc', 'abcd'), 'tamanhos diferentes não deveriam bater');
  confirmar(!iguaisEmTempoConstante('', 'a'), 'vazio contra preenchido não deveria bater');
  confirmar(iguaisEmTempoConstante('', ''), 'dois vazios deveriam bater');
});

await executar('Painel NBZ — Worker');

/* Fotos e plantas no R2.

   O binario vai para o bucket; o D1 guarda so a chave do objeto e os metadados.
   E o que faz a foto tirada na obra aparecer para a diretoria em outro
   aparelho, no lugar de ficar presa no localStorage de quem tirou.

   Chave do objeto: obras/<obra>/<relatorio>/<foto>.<ext>
   Plantas:         obras/<obra>/plantas/<pavimento>.<ext>

   O prefixo por obra nao e enfeite: permite apagar a obra inteira do bucket com
   um unico `list` por prefixo quando ela for excluida.
*/
import { agora, novoId } from './cripto.js';

/* 10 MB cobre planta grande; foto comprimida pelo painel fica em ~250 KB. O
   limite existe porque o corpo do request e lido inteiro na memoria do Worker,
   que tem 128 MB — sem teto, um upload grande derruba a requisicao. */
export const LIMITE_BYTES = 10 * 1024 * 1024;

const TIPOS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

/* Confere a assinatura do arquivo, nao o Content-Type.

   O cabecalho e escolhido por quem envia e nao prova nada: aceitar por ele
   deixaria subir qualquer coisa com `Content-Type: image/jpeg` no rotulo. Ler
   os primeiros bytes e o que de fato distingue uma imagem. */
function tipoReal(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const riff = String.fromCharCode(b[0], b[1], b[2], b[3]);
  const webp = String.fromCharCode(b[8], b[9], b[10], b[11]);
  if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  return null;
}

/* Espelha a permissao `photos.edit` de `roleDefinitions` no index.html: quatro
   dos cinco cargos registram fotografia, e so 'cliente' fica de fora.

   Restringir isso a administrador e engenheiro — como estava — barraria
   encarregado e tecnico, que sao justamente quem faz a vistoria em campo e tira
   a foto. A regra tem de ser a mesma dos dois lados. */
export function podeEnviarFoto(sessao) {
  return Boolean(sessao) && sessao.nivelAcesso !== 'cliente';
}

/* O R2 precisa ser ativado uma vez no painel da Cloudflare antes do primeiro
   uso, e isso pode nao ter sido feito ainda. Sem este aviso, a falta do binding
   apareceria como "Erro interno" — que nao diz a ninguem o que fazer.

   O resto do sistema nao depende disto: login, usuarios, obras, setores e
   situacoes funcionam sem o R2. Apenas as fotografias ficam no aparelho ate o
   bucket existir, e a fila as envia sozinha quando ele aparecer. */
function bucketAusente(env) {
  if (env.FOTOS) return null;
  return {
    erro: 'O armazenamento de fotografias ainda não foi ativado nesta conta. '
      + 'Ative o R2 no painel da Cloudflare; as fotos ficam guardadas no aparelho até lá.',
    status: 503
  };
}

/* --------------------------------------------------------------- upload */

export async function enviar(env, sessao, pedido, parametros) {
  if (!podeEnviarFoto(sessao)) {
    return { erro: 'Seu cargo não permite enviar fotografias.', status: 403 };
  }
  const semBucket = bucketAusente(env);
  if (semBucket) return semBucket;

  const relatorioId = String(parametros.get('relatorio') || '').trim();
  if (!relatorioId) return { erro: 'Informe o relatório da fotografia.', status: 400 };

  const relatorio = await env.DB.prepare(
    'select id, obra_id from relatorios_foto where id = ? and excluido_em is null'
  ).bind(relatorioId).first();
  if (!relatorio) return { erro: 'Relatório não encontrado.', status: 404 };

  const declarado = Number(pedido.headers.get('content-length') || 0);
  if (declarado > LIMITE_BYTES) {
    return { erro: `A imagem passa do limite de ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB.`, status: 413 };
  }

  const bytes = await pedido.arrayBuffer();
  if (!bytes.byteLength) return { erro: 'Corpo da requisição vazio.', status: 400 };
  /* Confere de novo pelo tamanho real: `content-length` tambem e informado por
     quem envia e pode nao corresponder ao corpo. */
  if (bytes.byteLength > LIMITE_BYTES) {
    return { erro: `A imagem passa do limite de ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB.`, status: 413 };
  }

  const tipo = tipoReal(bytes);
  if (!tipo) return { erro: 'Arquivo não é JPG, PNG ou WEBP.', status: 415 };

  const id = parametros.get('id') || novoId();
  const chave = `obras/${relatorio.obra_id}/${relatorio.id}/${id}.${TIPOS[tipo]}`;

  await env.FOTOS.put(chave, bytes, {
    httpMetadata: {
      contentType: tipo,
      /* Imutavel: a chave carrega o id da foto, entao substituir uma imagem
         gera chave nova. Isso deixa o cache do navegador e o do R2 segurarem a
         imagem por um ano sem revalidar. */
      cacheControl: 'public, max-age=31536000, immutable'
    },
    customMetadata: { obra: relatorio.obra_id, relatorio: relatorio.id, autor: sessao.id }
  });

  /* `insert or replace` em vez de `insert`: a fila offline do painel pode
     reenviar a mesma foto se a resposta se perdeu no caminho, e o reenvio tem
     de ser inofensivo em vez de estourar a restricao de unicidade. */
  await env.DB.prepare(
    `insert or replace into fotos
       (id, relatorio_id, r2_key, bytes, largura, altura, legenda, incluir_laudo, data, autor_id, atualizado_em)
     values (?, ?, ?, ?, ?, ?, ?, ?, coalesce((select data from fotos where id = ?), ?), ?, ?)`
  ).bind(
    id, relatorio.id, chave, bytes.byteLength,
    Number(parametros.get('largura') || 0), Number(parametros.get('altura') || 0),
    String(parametros.get('legenda') || '').slice(0, 220),
    parametros.get('laudo') === '0' ? 0 : 1,
    id, agora(), sessao.id, agora()
  ).run();

  return {
    foto: {
      id,
      relatorioId: relatorio.id,
      url: `/fotos/${id}`,
      bytes: bytes.byteLength,
      tipo
    }
  };
}

/* --------------------------------------------------------------- leitura */

/* Serve o objeto do R2. Devolve Response pronta em vez de JSON porque o
   `<img src>` do painel aponta direto para esta rota. */
export async function servir(env, sessao, id, pedido) {
  if (!env.FOTOS) return new Response('Armazenamento de fotografias não ativado.', { status: 503 });
  const linha = await env.DB.prepare(
    'select r2_key from fotos where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!linha) return new Response('Fotografia não encontrada.', { status: 404 });

  /* If-None-Match antes de tocar no R2: com a imagem imutavel, o navegador que
     ja tem a foto recebe 304 sem gastar leitura no bucket. */
  const etagCliente = pedido.headers.get('if-none-match');

  const objeto = await env.FOTOS.get(linha.r2_key);
  if (!objeto) return new Response('Arquivo ausente no bucket.', { status: 404 });

  if (etagCliente && etagCliente === objeto.httpEtag) {
    return new Response(null, { status: 304, headers: { etag: objeto.httpEtag } });
  }

  const cabecalhos = new Headers();
  objeto.writeHttpMetadata(cabecalhos);
  cabecalhos.set('etag', objeto.httpEtag);
  /* `private`: a foto e de obra de cliente e nao deve ficar em cache
     compartilhado de proxy, so no navegador de quem tem acesso. */
  cabecalhos.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(objeto.body, { headers: cabecalhos });
}

/* --------------------------------------------------------------- exclusao */

export async function excluir(env, sessao, id) {
  const linha = await env.DB.prepare(
    'select id, r2_key, autor_id from fotos where id = ? and excluido_em is null'
  ).bind(id).first();
  if (!linha) return { erro: 'Fotografia não encontrada.', status: 404 };

  const semBucket = bucketAusente(env);
  if (semBucket) return semBucket;

  const proprio = linha.autor_id === sessao.id;
  if (sessao.nivelAcesso !== 'administrador' && !(proprio && podeEnviarFoto(sessao))) {
    return { erro: 'Seu cargo não permite excluir esta fotografia.', status: 403 };
  }

  /* Marca no D1 primeiro. Se o delete no R2 falhar, sobra um objeto orfao
     ocupando cota — incomodo e recuperavel. Na ordem inversa, uma falha
     deixaria uma linha apontando para arquivo que nao existe mais, e a galeria
     passaria a mostrar imagem quebrada. */
  await env.DB.prepare('update fotos set excluido_em = ?, atualizado_em = ? where id = ?')
    .bind(agora(), agora(), id).run();
  try {
    await env.FOTOS.delete(linha.r2_key);
  } catch {
    /* O objeto fica para a limpeza por prefixo; a foto ja saiu do painel. */
  }

  return { ok: true };
}

/* --------------------------------------------------------------- plantas */

export async function enviarPlanta(env, sessao, pedido, parametros) {
  if (!podeEnviarFoto(sessao)) {
    return { erro: 'Seu cargo não permite importar plantas.', status: 403 };
  }
  const semBucket = bucketAusente(env);
  if (semBucket) return semBucket;

  const pavimentoId = String(parametros.get('pavimento') || '').trim();
  const pavimento = await env.DB.prepare(
    'select id, obra_id from pavimentos where id = ? and excluido_em is null'
  ).bind(pavimentoId).first();
  if (!pavimento) return { erro: 'Pavimento não encontrado.', status: 404 };

  const bytes = await pedido.arrayBuffer();
  if (!bytes.byteLength) return { erro: 'Corpo da requisição vazio.', status: 400 };
  if (bytes.byteLength > LIMITE_BYTES) {
    return { erro: `A planta passa do limite de ${Math.round(LIMITE_BYTES / 1024 / 1024)} MB.`, status: 413 };
  }

  const tipo = tipoReal(bytes);
  if (!tipo) {
    /* O PDF e convertido em imagem pelo painel antes de subir (pdf.js roda no
       navegador), entao aqui so chega imagem. */
    return { erro: 'A planta deve chegar como JPG, PNG ou WEBP.', status: 415 };
  }

  /* Versao na chave para que trocar a planta nao precise invalidar cache: a
     chave nova nunca colide com a antiga. */
  const chave = `obras/${pavimento.obra_id}/plantas/${pavimento.id}-${Date.now()}.${TIPOS[tipo]}`;
  await env.FOTOS.put(chave, bytes, {
    httpMetadata: { contentType: tipo, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { obra: pavimento.obra_id, pavimento: pavimento.id, autor: sessao.id }
  });

  const anterior = await env.DB.prepare('select planta_r2_key from pavimentos where id = ?')
    .bind(pavimento.id).first();

  await env.DB.prepare(
    `update pavimentos
        set planta_r2_key = ?, planta_largura = ?, planta_altura = ?,
            planta_arquivo = ?, atualizado_em = ?
      where id = ?`
  ).bind(
    chave,
    Number(parametros.get('largura') || 0), Number(parametros.get('altura') || 0),
    String(parametros.get('arquivo') || '').slice(0, 120),
    agora(), pavimento.id
  ).run();

  if (anterior && anterior.planta_r2_key && anterior.planta_r2_key !== chave) {
    try {
      await env.FOTOS.delete(anterior.planta_r2_key);
    } catch {
      /* Planta antiga fica para a limpeza por prefixo. */
    }
  }

  return { planta: { pavimentoId: pavimento.id, url: `/plantas/${pavimento.id}`, bytes: bytes.byteLength } };
}

export async function servirPlanta(env, sessao, pavimentoId, pedido) {
  if (!env.FOTOS) return new Response('Armazenamento de plantas não ativado.', { status: 503 });
  const linha = await env.DB.prepare(
    'select planta_r2_key from pavimentos where id = ? and excluido_em is null'
  ).bind(pavimentoId).first();
  if (!linha || !linha.planta_r2_key) return new Response('Planta não encontrada.', { status: 404 });

  const objeto = await env.FOTOS.get(linha.planta_r2_key);
  if (!objeto) return new Response('Arquivo ausente no bucket.', { status: 404 });

  const etagCliente = pedido.headers.get('if-none-match');
  if (etagCliente && etagCliente === objeto.httpEtag) {
    return new Response(null, { status: 304, headers: { etag: objeto.httpEtag } });
  }

  const cabecalhos = new Headers();
  objeto.writeHttpMetadata(cabecalhos);
  cabecalhos.set('etag', objeto.httpEtag);
  cabecalhos.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(objeto.body, { headers: cabecalhos });
}

/* Service worker do painel NBZ.

   Estratégia: rede primeiro para o que é nosso (HTML, estilos, scripts), com o cache
   como reserva para uso offline; cache primeiro para fontes e bibliotecas externas,
   que são versionadas na própria URL e não mudam.

   A distinção existe por um motivo concreto. Os estilos saíram de dentro do index.html
   para src/estilos/, e enquanto moravam no HTML eles chegavam sempre frescos, porque o
   documento já era buscado na rede. Servir esses arquivos do cache primeiro os
   congelaria na primeira visita: uma publicação nova traria o HTML novo com o CSS
   antigo, até alguém trocar o nome do cache. Rede primeiro para a mesma origem elimina
   essa combinação, e quem está sem rede continua atendido pelo cache.

   Os dados das obras não passam por aqui: ficam no localStorage e no IndexedDB do
   navegador. Este arquivo só guarda os arquivos estáticos. */
const cacheName = 'nbz-obras-v2';

/* O precache cobre a primeira visita offline. `addAll` falha inteiro se um único
   endereço não responder, por isso a lista traz apenas arquivos que existem no
   repositório — e a falha é engolida de propósito, para uma publicação parcial não
   impedir a instalação. */
const precache = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icone-180.png',
  './icone-512.png',
  './src/db.js',
  './src/api.js',
  './src/sincronizar.js',
  './src/estilos/01-base.css',
  './src/estilos/02-cabecalho.css',
  './src/estilos/03-painel.css',
  './src/estilos/04-obras.css',
  './src/estilos/05-relatorios.css',
  './src/estilos/06-dialogos.css',
  './src/estilos/07-telas-pequenas.css',
  './src/estilos/08-fotos.css',
  './src/estilos/09-pavimentos.css',
  './src/estilos/10-acesso.css',
  './src/estilos/11-situacoes-e-galeria.css',
  './src/estilos/12-planta.css',
  './src/estilos/13-folha-pavimento.css',
  './src/estilos/14-toque.css',
  './src/estilos/15-local-e-equipe.css',
  './src/estilos/16-impressao-a4.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(precache)).catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function guardar(request, response) {
  if (!response.ok || (response.type !== 'basic' && response.type !== 'cors')) return;
  const copia = response.clone();
  caches.open(cacheName).then((cache) => cache.put(request, copia)).catch(() => undefined);
}

/* Rede primeiro, cache como reserva. Serve tanto para o documento quanto para os
   estilos e scripts: o que vale é chegar a versão publicada agora, e cair no cache
   quando não há rede. */
function redePrimeiro(request, reserva) {
  return fetch(request)
    .then((response) => {
      guardar(request, response);
      return response;
    })
    .catch(async (erro) => {
      const guardado = await caches.match(request)
        || (reserva ? await caches.match(reserva) : undefined);
      /* Sem rede E sem cópia guardada, repassa a falha original em vez de
         resolver com `undefined`: `respondWith` exige uma Response, e resolver
         com outra coisa troca o erro de rede honesto por um erro interno do
         service worker no console — que esconde a causa real. */
      if (!guardado) throw erro;
      return guardado;
    });
}

function cachePrimeiro(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      guardar(request, response);
      return response;
    });
  });
}

function isDocument(request) {
  return request.mode === 'navigate' || request.destination === 'document' || (request.headers.get('accept') || '').includes('text/html');
}

const TIPOS_ESTATICOS = ['style', 'script', 'font', 'image', 'manifest'];

/* Só arquivo estático entra no cache. Reconhecer isso pelo tipo do pedido, e não
   pela origem, é o que mantém as chamadas da API fora daqui: elas moram em outro
   domínio (o Worker), e uma resposta de obra guardada no cache voltaria a aparecer
   depois de uma sincronização, como dado velho que ninguém consegue explicar.

   `destination` vem vazio tanto em `fetch()` quanto em navegador que não implementa
   a propriedade. Nesse caso a extensão decide: as chamadas da API não terminam em
   .css nem .js, e as fotografias são buscadas por `fetch()` e guardadas no
   IndexedDB pelo próprio painel, sem precisar deste cache. */
function ehEstatico(request, url) {
  if (TIPOS_ESTATICOS.includes(request.destination)) return true;
  if (request.destination) return false;
  return /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|webmanifest)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith('http')) return;

  if (isDocument(request)) {
    event.respondWith(redePrimeiro(request, './index.html'));
    return;
  }

  const url = new URL(request.url);
  if (!ehEstatico(request, url)) return;

  event.respondWith(url.origin === self.location.origin ? redePrimeiro(request) : cachePrimeiro(request));
});

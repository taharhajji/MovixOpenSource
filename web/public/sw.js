// MEWFLIX web : aucun service worker. Celui du site d'origine redirige vers des
// miroirs Movix quand l'hôte ne répond pas ; ici il se désinscrit lui-même.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) client.navigate(client.url);
  })());
});

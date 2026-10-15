# MEWFLIX — version web (mobile et bureau, dans le navigateur)

Le site Movix du dépôt (`src/`, Vite) compilé et rebrandé MEWFLIX, servi par Vercel. Remplace la version iOS : sur iPhone/Android, on l'ouvre dans Safari/Chrome et on l'ajoute à l'écran d'accueil (PWA, icône MEWFLIX).

## Comment ça marche

- **Front** : le build Vite du dépôt, avec une base d'API **relative** (`/api/…`). Le même `dist/` sert donc n'importe quelle URL Vercel ou un domaine personnalisé, sans recompiler.
- **Relais d'API** : l'API Movix refuse les navigateurs venant d'un autre domaine (403 « Not allowed by CORS »). La fonction Edge [`api/[...path].js`](api/%5B...path%5D.js) retransmet chaque appel `/api/*` à `https://api.movix.luxe` sans l'en-tête Origin (l'API l'accepte alors comme une app mobile), en flux, méthodes/corps/cookies conservés. Variable d'environnement `UPSTREAM_API` pour changer la cible.
- **Retouches de site** (mêmes que l'app de bureau, injectées dans `index.html` avant tout script) : marque Movix masquée, popup « voir une pub » en mode auto, statut VIP local, SwiftFlux reléguée, et popups externes neutralisés (hors Telegram/GitHub/Discord/YouTube/TMDB/Wikipédia).
- **PWA** : `manifest.json` et icônes MEWFLIX ; le service worker du site (qui redirige vers des miroirs Movix quand l'hôte ne répond pas) est remplacé par un worker qui se désinscrit.

## Construire

```bash
npm ci                      # à la racine du dépôt (dépendances du front)
npm run build:web --prefix web   # vite build + rebranding → web/dist
```

Options : `--upstream https://api.exemple` (API relayée), `--origin https://mon-domaine` (base absolue au lieu de relative, inutile en général), `--skip-vite` (rebrander un `dist/` déjà construit). Clés Turnstile : `VITE_TURNSTILE_SITE_KEY` / `VITE_TURNSTILE_INVISIBLE_SITEKEY` dans l'environnement du build (voir « Limites »).

## Tester en local (même comportement que Vercel)

```bash
node web/scripts/serve-local.mjs --port 4312
```

Sert `web/dist` avec repli SPA et relaie `/api/*` sans Origin, exactement comme la fonction Edge.

## Déployer sur Vercel

Depuis `web/` (le dossier contient `vercel.json`, `api/` et `dist/`) :

```bash
cd web
npx vercel login          # une fois
npx vercel deploy --prod  # projet « mewflix-app » (mewflix.vercel.app est déjà pris)
```

`vercel.json` : pas de build côté Vercel (`dist/` est livré tel quel), repli SPA vers `index.html`, cache long sur `/assets/`. Un domaine personnalisé s'ajoute ensuite dans le projet Vercel sans rien recompiler.

## Limites (à régler côté serveur Movix)

- **Turnstile** : les clés de widget sont liées aux domaines Movix. Sur un autre domaine, le widget est refusé par Cloudflare ; les actions qui exigent un jeton côté API (création de compte et connexion BIP39, saisie de code VIP, lecture SwiftFlux, commentaires) échouent tant que le domaine Vercel n'est pas ajouté au widget Turnstile dans le tableau de bord Cloudflare. La navigation, la recherche et la lecture des autres sources fonctionnent sans compte.
- **OAuth Discord/Google** : l'URL de retour est `${origin}/auth` ; le domaine Vercel doit être déclaré dans les consoles Discord et Google.
- **WatchParty** : Socket.IO ne passe pas par le relais (pas de WebSocket sur Vercel) et vise l'API directement, bloqué par son CORS tant que le domaine n'y est pas autorisé.
- **Sources** : pas d'extension dans un navigateur mobile — seules les sources que le site sait lire sans extraction locale sont disponibles, comme sur movix.luxe depuis un téléphone.
- Pas de blocage réseau des régies (les popups sont neutralisés, pas les scripts).

Pour lever les trois premières limites, il suffit d'ajouter le domaine de déploiement à la liste CORS de l'API (`API/Mainapi/middleware/cors.js`, ou l'environnement correspondant), au widget Turnstile et aux applications OAuth : le relais devient alors facultatif.

## Relais média `/media` (rustine de phase de test)

Le CDN HLS de la source « pulse » (`*.finepulfe.xyz`) refuse toute requête dont
l'Origin n'est pas un domaine Movix : depuis `mewflix-app.vercel.app` le lecteur
recevait 403 et retombait sur des embeds tiers. `web/api/media.js` relaie ces
hôtes (liste close `MEDIA_RELAY_HOSTS`, suffixes séparés par des virgules) sans
Origin ni Referer, réécrit les playlists `.m3u8` en URL absolues `/media/<fichier>?u=…`
et renvoie les segments avec CORS ouvert. Le détour côté lecteur (XHR, fetch,
`src` natif) est injecté par `buildSiteTweaks({ mediaRelay })`.

Chaque octet vidéo transite par Vercel (quota « Fast Origin Transfer ») : la
vraie solution reste l'ajout du domaine dans la liste d'origines autorisées du
CDN, côté team. Pour couper le relais : retirer `mediaRelay` dans `scripts/build.mjs`.

## Nuit du 12 octobre 2026 — ce qui a changé

- **Thème MEWFLIX** (`scripts/theme.mjs`) : la palette rouge de Tailwind (identité Movix)
  est réécrite en bleu ardoise tiré du logo, dans les CSS et les bundles JS, après build.
  `scripts/extract-theme-css.mjs` en tire la feuille `desktop/src/injection/theme.css` pour l'app de bureau.
- **PWA** : `public/sw.js` (navigation réseau d'abord, `offline.html` quand le réseau manque,
  `/assets/` en cache), manifeste `standalone` avec icônes 192/512/1024 + maskable,
  bouton « Installer MEWFLIX » sur mobile (Android : invite native ; iPhone : explication).
- **Extras web** (`scripts/web-extras.mjs`, injectés en fin de body) : logo dans l'en-tête,
  « Surprends-moi » (un titre au hasard lancé dans le lecteur), bouton « Remonter »,
  et la **porte « pas de source sans publicité »** : aucun lecteur tiers (iframe) ne se charge
  sans accord explicite ; le choix se range dans `mewflix_web:embeds_mode` et se défait d'un geste.
- **Relais signé** (`api/media.js`, `api/proxy.js`) : les adresses de flux renvoyées par l'API
  sont réécrites vers `/media/...&s=<HMAC>` ; n'importe quel CDN passe sans redéploiement.
  Secret : variable `MEDIA_RELAY_SECRET` (Vercel) et `web/.env.relay.local` (miroir local, ignoré par git).
- **API plus robuste** : trois tentatives sur panne réseau ou 502/503/504, catalogue
  (`tmdb/`, `trending/`, `links/`…) mis en cache sur le réseau Vercel et servi périmé pendant une panne.
- **État du service** : `/api/health` (JSON) et la page `/status`.
- **Relais Cloudflare prêt** : `relay-worker/` (même code, sans quota de bande passante) ;
  activer avec `MEDIA_RELAY_BASE`, voir son README.

Tests : `node --test web/tests/*.test.mjs` (relais, signature, thème) et `cd desktop && npm test`.

## TV en direct (15 octobre 2026)

- La page TV construit `new URL()` à partir de la base d'API : le build utilise désormais
  une base **absolue** (`--origin`, défaut = URL publique du site) au lieu d'une base relative.
- Les flux « directs » renvoyés par `/api/livetv/stream/*` (Vavoo : IP nue, http, port 8008,
  User-Agent `VAVOO/2.6`) sont réécrits vers le relais média avec leurs en-têtes signés
  (paramètre `h`, couvert par la signature). Les lecteurs en iframe (Northlive, Streamed…) restent tels quels.
- **Vavoo** refuse les adresses IP des hébergeurs (403 depuis Vercel, 200 depuis une box) :
  ces chaînes ne passent qu'avec l'app Windows (le userscript les lit depuis l'IP du spectateur),
  comme avec l'extension sur Movix. Northlive, FCTV et Streamed (lecteurs en iframe) fonctionnent sur le web.
- Les chaînes **IPTV** (onglet « IPTV Web ») sont réservées par l'API aux clés VIP réelles
  (`x-access-key`) : le statut VIP local de MEWFLIX ne suffit pas ; il faut une clé générée
  par un administrateur de l'API (`POST /admin/vip-keys`), à saisir dans le site.

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

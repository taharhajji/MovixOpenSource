# Orbit — Application de bureau (Windows)

Application Windows (`.exe`) construite avec Electron, qui charge le site Movix sous une identité propre (« Orbit »). Même principe que l'[app mobile](../app/README.md) : elle charge le site Movix en direct — donc l'API et les serveurs de production, sans copie du front à maintenir — avec l'extension Movix intégrée (le userscript + un pont `GM_*` natif, sans CORS) et la bascule automatique entre miroirs.

## Ce que fait l'app

- **Résolution des miroirs** : `rentry.co/movix` → `https://<hôte>/address.json` → cache local → liste codée en dur (même chaîne que l'app mobile). Le dernier miroir qui a répondu est essayé en premier.
- **Bascule automatique** : erreur réseau ou HTTP 5xx/52x sur un miroir → le suivant ; tous en échec → page d'erreur avec « Réessayer ».
- **Extension intégrée** : `userscript/movix.user.js` est injecté dans la page avant tout script du site. `GM_xmlhttpRequest` est exécuté par le processus principal (en-têtes `Origin`/`Referer`/`User-Agent` libres, redirections suivies avec les règles d'en-têtes par hébergeur). Le site détecte l'extension exactement comme avec Tampermonkey.
- **Requêtes média natives** : les règles d'en-têtes des hébergeurs (Fsvid, Vidzy, Uqload, LuluStream, Veev, Vidara) sont aussi appliquées aux requêtes émises par le moteur web (`<video>`, segments), l'équivalent des règles `declarativeNetRequest` de l'extension Chrome. CORS ouvert pour les ressources tierces demandées par le site, sans toucher aux en-têtes posés par l'API Movix.
- **Navigation** : les domaines Movix et l'OAuth Discord/Google restent dans la fenêtre ; régies pub, Telegram et liens externes s'ouvrent dans le navigateur par défaut.
- **Session persistante** (connexion, profils, préférences), fenêtre restaurée, zoom, plein écran (F11), menu caché (touche Alt).
- **Mises à jour automatiques** depuis les releases GitHub du dépôt (build packagé uniquement).

## Identité de l'app (dissociée du site)

L'interface ne mentionne pas Movix : nom de fenêtre, menus, pages de chargement/erreur, boîtes de dialogue, nom de l'exe et icône sont ceux d'**Orbit**. Le titre de la fenêtre reste « Orbit » quel que soit le `<title>` du site, et les miroirs sont présentés comme « Serveur 1, 2, … », jamais par leur domaine. Le contenu de la page web (le site lui-même) n'est pas modifié.

Tout part de [`src/branding.js`](src/branding.js) (nom, slogan, identifiant, couleurs, jeton User-Agent `OrbitDesktop/<version>`). Pour renommer : modifier ce fichier et les champs `name` / `productName` / `build.appId` / `build.nsis.shortcutName` de `package.json`, puis `npm run icon` pour regénérer `build/icon.png` (dessiné en SVG dans `scripts/render-icon.js`, rendu hors écran par Electron).

Les données locales (session, config, cache des filtres) vivent dans `%APPDATA%\Orbit`.

## Blocage des publicités (phase de test)

Tant que l'app n'est pas publiée, **toutes les pubs sont bloquées par défaut**, sur trois couches :

1. **Liste intégrée** de régies, popunders, smartlinks et traqueurs (`src/lib/adBlock.js`), active hors ligne dès le démarrage.
2. **Moteur de filtres Ghostery** (`@ghostery/adblocker`) avec EasyList + EasyPrivacy : les listes sont téléchargées au premier lancement puis mises en cache dans `%APPDATA%\Movix\adblock-engine.bin`. Les requêtes bloquées échouent côté page en `ERR_BLOCKED_BY_CLIENT`, exactement comme avec uBlock.
3. **Popups et redirections sortantes** : `window.open` vers un hôte externe non sûr renvoie une fenêtre factice ; les navigations vers des smartlinks sont ignorées. Telegram, GitHub, Discord, YouTube, TMDB, Wikipédia restent ouvrables dans le navigateur.
4. **Plus de fenêtre « voir une pub avant de regarder »** : le site possède un mode « auto » pour ce popup (réglage Intermission, clé `settings_ad_popup_mode`). L'app le force avant le chargement de la page : rien n'est affiché, le lien pub est ouvert en arrière-plan (donc neutralisé par la couche 3) et la lecture démarre directement. Le réglage précédent est restauré si le blocage est désactivé. La porte SwiftFlux (catalogue MP4) garde son étape « voir une pub » : un clic, aucune pub ne part, puis Turnstile.

Jamais bloqués : le site et ses miroirs, l'hôte imposé, l'API, TMDB, l'OAuth Discord/Google, Turnstile, les résolveurs de miroirs.

Pour couper le blocage (par exemple pour tester la monétisation) :

```bash
Orbit.exe --adblock=off        # ou MOVIX_ADBLOCK=0, ou le menu Orbit › « Bloquer les publicités »
```

Le réglage du menu est mémorisé dans `config.json` (`"adBlock": false`). **Avant la publication**, passer la valeur par défaut à `false` dans `src/lib/config.js` (`DEFAULTS.adBlock`) ou retirer la fonctionnalité. Le menu « À propos » affiche le nombre de requêtes et de popups bloqués, avec les hôtes les plus fréquents.

## Pour la team : pointer un autre serveur

Trois façons d'imposer l'URL du site (par ordre de priorité) :

```bash
# 1. ligne de commande
Orbit.exe --site=http://localhost:3000

# 2. variable d'environnement
set MOVIX_SITE_URL=https://staging.exemple.tld

# 3. fichier %APPDATA%\Orbit\config.json  (menu Orbit › Ouvrir le dossier de configuration)
{ "siteUrl": "https://staging.exemple.tld" }
```

Le front chargé continue d'utiliser ses propres `VITE_MAIN_API` / `VITE_WATCHPARTY_API` : pour tester une API locale, lancez `npm run dev` à la racine avec un `.env` qui pointe dessus, puis l'app avec `--site=http://localhost:3000`. Le userscript s'injecte aussi sur `localhost`.

Les sessions bureau sont identifiables côté API par le suffixe `OrbitDesktop/<version>` du User-Agent (libellées « Movix Desktop » dans `sessionDeviceInfo.js`).

## Prérequis

- Node.js 20+ (22 recommandé)
- Windows 10/11 pour produire l'installeur (electron-builder construit la cible `nsis` et `portable` nativement ; sous Linux/macOS il faut Wine)

## Installation et lancement

```bash
cd desktop
npm install
npm start          # copie le userscript puis lance l'app
npm run dev        # idem + DevTools détachés + journal console de la page dans le terminal
npm test           # tests unitaires (règles d'en-têtes, résolution d'adresse, navigation, config)
```

`npm start`/`npm run build` exécutent `scripts/sync-userscript.mjs`, qui copie `../userscript/movix.user.js` dans `resources/` (ignoré par git). Si vous modifiez le userscript, relancez simplement `npm start`.

## Build de l'exécutable

```bash
cd desktop
npm run build
```

Produit dans `desktop/dist/` :

| Fichier | Rôle |
| --- | --- |
| `Orbit-Setup-<version>.exe` | Installeur NSIS (choix du dossier, raccourcis bureau + menu Démarrer, mises à jour auto) |
| `Orbit-<version>-portable.exe` | Exécutable portable, sans installation |
| `latest.yml` | Manifeste lu par l'auto-updater |

L'icône de l'exe est générée depuis `build/icon.png` (`npm run icon`).

### Publier une release (mises à jour automatiques)

Le workflow [`desktop-windows.yml`](../.github/workflows/desktop-windows.yml) compile sur `windows-latest` à chaque PR touchant `desktop/`. Sur un tag `desktop-v*` il **crée la release GitHub** (installeur, portable, blockmap, `latest.yml`) puis **commite `desktop/release/latest.yml` sur `main`** :

```bash
# bump de version dans desktop/package.json (doit égaler le tag), puis :
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

Pourquoi un manifeste dans le dépôt : le dépôt publie aussi des releases iOS (`ios-v*`), et l'auto-updater GitHub d'Electron ne regarde que la release « latest ». L'app lit donc `https://raw.githubusercontent.com/movixstream/MovixOpenSource/main/desktop/release/latest.yml` (URL stable, même principe que `app/version.json` pour l'APK), dont les entrées pointent vers les assets de la release `desktop-v<version>`. Pour le régénérer à la main après un build : `npm run release:manifest`.

Les apps installées (NSIS) détectent la nouvelle version au démarrage, la téléchargent et proposent de redémarrer. La version portable ne se met pas à jour toute seule.

Le build n'est pas signé : SmartScreen affichera un avertissement « éditeur inconnu » au premier lancement (« Informations complémentaires » → « Exécuter quand même »). Un certificat de signature de code (`win.certificateFile` / `WIN_CSC_LINK` dans electron-builder) le supprime.

## Architecture

```
desktop/
├── src/
│   ├── branding.js               # Identité de l'app (nom, couleurs, jeton UA) — dissociée du site
│   ├── main.js                   # Processus principal : fenêtre, miroirs, failover, menu, IPC, auto-update
│   ├── preload.js                # Expose window.__movixDesktop et injecte pont + userscript (document-start)
│   ├── injection/
│   │   └── bridge-runtime.js     # API Tampermonkey (GM_xmlhttpRequest, GM_getValue…, unsafeWindow) côté page
│   ├── lib/
│   │   ├── gmFetch.js            # GM_xmlhttpRequest natif (net.request, redirections manuelles, binaire en base64)
│   │   ├── mediaProxyHeaders.js  # Règles d'en-têtes par hébergeur (port de app/src/services/mediaProxyHeaders.ts)
│   │   ├── addressResolver.js    # rentry → address.json → cache → fallback (port de app/src/services/addressResolver.ts)
│   │   ├── navigationPolicy.js   # Ce qui reste dans la fenêtre / part dans le navigateur
│   │   ├── config.js             # %APPDATA%/Orbit/config.json, --site, MOVIX_SITE_URL
│   │   └── menu.js               # Menu applicatif (FR)
│   └── pages/                    # loading.html, error.html
├── scripts/sync-userscript.mjs   # Copie le userscript du dépôt dans resources/
├── scripts/render-icon.js        # Dessine l'icône (SVG) et la rend en PNG via Electron
├── resources/movix.user.js       # Généré, ignoré par git
├── build/icon.png                # Icône (→ .ico par electron-builder)
└── tests/                        # node --test
```

### Flux d'une requête du userscript

1. Le site appelle l'extension (`window.postMessage` `MOVIX_WEB` → le userscript, comme dans Tampermonkey).
2. Le userscript fait `GM_xmlhttpRequest(details)`.
3. `bridge-runtime.js` sérialise la requête (corps binaire en base64) et appelle `window.__movixDesktop.gmFetch`.
4. Le preload relaie par IPC (`gm:fetch`) au processus principal.
5. `gmFetch.js` exécute `net.request` avec les cookies de session, applique `applyMediaProxyHeaderRules` à chaque saut de redirection, renvoie statut/en-têtes/corps.
6. Le pont reconstruit la réponse Tampermonkey (`responseText`, `response` en ArrayBuffer/Blob/JSON selon `responseType`, `responseHeaders`, `finalUrl`) et appelle `onload`.

## Limites connues

- **DRM (Widevine)** : non disponible dans un Electron standard. Les sources protégées par DRM ne se lisent pas ; les autres (HLS, MP4, DASH en clair) oui.
- **Proxy média local** (`GM_openMediaProxy`) : spécifique au mobile, absent ici — le moteur web lit les flux directement, les en-têtes sont posés par `webRequest`.
- **Discord Rich Presence** : pas intégré (voir [`PreMid/`](../PreMid)).
- Windows x64 uniquement dans la config de build ; macOS/Linux se rajoutent dans `package.json › build` (sans signature Apple, macOS exigera un clic droit → Ouvrir).

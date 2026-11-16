# MEWFLIX — Android TV

Appli pour les télés et boîtiers Android TV / Google TV (TCL, Sony, Philips, Xiaomi, Chromecast avec Google TV…).
Un seul écran plein cadre, piloté par la télécommande de la télé. APK d'environ 600 Ko.

C'est la même chose que le [mode TV de l'appli de bureau](../desktop/README.md#mode-tv-110), sans PC :

| Brique | Bureau (Electron) | Android TV |
| --- | --- | --- |
| Interface télé | `desktop/src/injection/tv-app.js` | le même fichier, embarqué |
| Pont « extension » (userscript + `GM_xmlhttpRequest`) | `desktop/src/injection/bridge-runtime.js` + `lib/gmFetch.js` | même script côté page, `GmBridge.java` + `NativeHttp.java` côté natif |
| En-têtes des hébergeurs | `lib/mediaProxyHeaders.js` | `HostRules.java` (port à l'identique, testé) |
| CORS ouvert sur les flux tiers | `session.webRequest` | `MediaRelay.java` (la requête est refaite nativement) |
| Blocage des régies | listes de filtres + mode strict | liste intégrée de `lib/adBlock.js` seulement |
| Télécommande | téléphone (QR code) ou clavier | télécommande de la télé (`MainActivity.dispatchKeyEvent`) |

## Fonctionnement

- `MainActivity` charge une page **légère** du site (`HOME_PATH`, `/robots.txt`) : même origine que le site, donc mêmes
  réglages et même « Reprendre la lecture », mais sans charger tout le site derrière l'interface (accueil en ~5 s au lieu
  de ~20 s). Le site complet n'est chargé que pour lire (`/watch/…`).
- Deux scripts sont injectés au démarrage du document (`addDocumentStartJavaScript`) : `inject-site.js` sur les pages du
  site (interface télé, pont GM, userscript) et `inject-frame.js` dans tous les cadres (relais des touches vers la vidéo
  des lecteurs externes, par `postMessage`).
- Chaque touche appelle `window.__mewflixAndroidKey(touche)` ; la valeur renvoyée dit à l'activité quoi faire (`done`,
  `exit`, `tap` = toucher le centre de l'écran, `wait` = attendre la réponse des cadres). **Rien n'est exposé à la page**
  en dehors de `MewflixNative` (pont GM), limité au cadre principal des pages du site.
- **DNS chiffré (1.0.1)** : les box Internet bloquent le site au niveau du DNS (« domaine inexistant »), ce qui donnait
  « Serveur injoignable » puis « Connexion impossible » sur toutes les télés. Tout le trafic passe donc par un relais
  local (`LocalProxy`, 127.0.0.1, imposé au WebView par `ProxyController`) qui résout les noms par DNS-over-HTTPS
  (`DohResolver` : Cloudflare, Google, Quad9, joints par leur adresse IP ; DNS du système en dernier recours).
  Le relais n'ouvre que des tunnels `CONNECT` : le HTTPS n'est ni lu ni modifié. Même rôle que le « DNS sécurisé » du bureau.
  Pour reproduire une box qui bloque : `EMU_DNS=192.0.2.1 emulator-wsl.sh start`.
- Écran « Connexion impossible » : il affiche la cause du dernier échec et la version, à se faire transmettre.
- **Lien d'installation** : `is.gd/mewflixtv` pointe sur le fichier `MEWFLIX-TV-1.0.0.apk` de la release `tv-v1.0.0`.
  Un lien court ne se modifie pas : à chaque version, remplacer ce fichier (`gh release upload tv-v1.0.0 … --clobber`,
  même nom) en plus de la release `tv-v<version>`, toujours créée avec `--latest=false`.
- Pendant un chargement de page, l'écran « Chargement… » est affiché et les touches sont ignorées.
- Si un miroir ne répond pas, le suivant de `mirrors.txt` est essayé ; faute de réseau, écran « Connexion impossible »
  (OK pour réessayer).

## Construire

Tout se fait dans WSL Ubuntu (aucun outil Android côté Windows) :

```bash
# une fois : JDK 17, kit Android, Gradle, émulateur Android TV
wsl -d Ubuntu -- bash /mnt/c/.../android-tv/scripts/setup-wsl.sh
# APK signé → android-tv/dist/MEWFLIX-TV-<version>.apk (lance aussi les tests JUnit)
wsl -d Ubuntu -- bash /mnt/c/.../android-tv/scripts/build-wsl.sh
# APK de test (journal détaillé, touche F12 = état, ouverture directe d'une page)
wsl -d Ubuntu -- bash /mnt/c/.../android-tv/scripts/build-wsl.sh debug
```

`scripts/build-assets.mjs` génère `app/src/main/assets/` à partir de `desktop/src` et `userscript/` (non versionné).
La version se change dans `app/build.gradle` (`versionCode` + `versionName`).

**Clé de signature** : créée au premier build dans `~/.mewflix/` (WSL) et recopiée dans `C:\Users\<toi>\.mewflix\`.
Elle n'est pas dans le dépôt et ne doit jamais y entrer. Si elle est perdue, plus aucune mise à jour ne s'installe
par-dessus une version déjà distribuée (il faut désinstaller puis réinstaller).

## Tester sans télé

```bash
E="bash /mnt/c/.../android-tv/scripts/emulator-wsl.sh"
wsl -d Ubuntu -- bash -c "$E start"        # bloquant : à laisser tourner dans un terminal à part
wsl -d Ubuntu -- bash -c "$E wait && $E install /mnt/c/.../android-tv/dist/MEWFLIX-TV-1.0.0-debug.apk"
wsl -d Ubuntu -- bash -c "$E key down right ok; $E state; $E shot /mnt/c/.../capture.png"
wsl -d Ubuntu -- bash -c "$E open /watch/movie/27205"   # build de test uniquement
```

L'émulateur tourne sans fenêtre avec l'accélération KVM de WSL2. WSL arrête les processus d'une session dès qu'elle se
termine : `start` doit donc rester au premier plan.

## Limites connues

- **Publicités** : pas de mode strict comme sur le bureau. Les sources directes n'en ont pas ; un lecteur de secours
  (iframe d'un hébergeur) peut afficher les siennes. Redirections et fenêtres surgissantes sont bloquées.
- **Mises à jour** : pas de mise à jour automatique ; il faut réinstaller l'APK par-dessus.
- **Liste des miroirs** figée à celle de `desktop/src/lib/addressResolver.js` au moment du build (pas de lecture de la
  liste en ligne).
- **Vérifié uniquement sur l'émulateur** Google TV (Android 16, 1080p) : jamais lancé sur une vraie télé.
- WebView trop ancien (sans `DOCUMENT_START_SCRIPT` / `WEB_MESSAGE_LISTENER`) : l'appli démarre mais retombe sur les
  lecteurs externes.

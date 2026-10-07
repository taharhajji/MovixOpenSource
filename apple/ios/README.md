# MEWFLIX pour iOS

Electron n'existe pas sur iOS. La version iOS de MEWFLIX est donc **l'app mobile React Native du dépôt (`app/`)** — un WebView du site avec le userscript et un pont natif, exactement le même principe que l'app de bureau — **habillée MEWFLIX** par un script, puis compilée par le workflow iOS existant.

## Contenu du dossier

| Fichier | Rôle |
| --- | --- |
| `apply-branding.mjs` | Applique l'habillage MEWFLIX à `app/` : nom affiché, identifiant `com.mewflix.app`, icônes, `CONFIG.APP_NAME`, et branche les retouches de site (marque masquée, popup pub auto, VIP local, SwiftFlux relégué) dans `app/src/injection/inject.ts`. Idempotent, `--check` pour vérifier sans écrire. |
| `make-icons.cjs` | Génère `AppIcon.appiconset/` (13 tailles, opaques, sans coins arrondis comme l'exige iOS) depuis `desktop/build/logo-source.jpg`. À relancer si le logo change : `cd desktop && node node_modules/electron/cli.js ../apple/ios/make-icons.cjs`. |
| `AppIcon.appiconset/` | Jeu d'icônes généré, copié dans le projet Xcode par `apply-branding.mjs`. |

Le code des retouches de site n'est pas dupliqué : `apply-branding.mjs` le génère depuis `desktop/src/injection/site-tweaks.js` (fichier `app/src/injection/site-tweaks-source.ts`), comme `app/scripts/build-userscript.js` le fait pour le userscript.

## Produire l'IPA

### Par GitHub Actions (aucun Mac nécessaire)

Workflow `iOS MEWFLIX unsigned IPA` (`.github/workflows/ios-mewflix-unsigned.yml`) : lancement manuel depuis l'onglet Actions, ou tag `mewflix-ios-v*`. Il applique l'habillage, compile sur un runner macOS sans signature, et publie l'artefact `MEWFLIX-unsigned-<version>-<run>` contenant `MEWFLIX-unsigned.ipa` et sa somme SHA-256. Le dépôt `app/` n'est pas modifié : l'habillage n'existe que le temps du build.

### Sur un Mac

```bash
node apple/ios/apply-branding.mjs      # habillage (modifie app/, réversible)
cd app && npm ci && npm run build:userscript
cd ios && pod install && cd ..
# puis le build Xcode habituel (scheme Movix) — voir app/README.md
```

Pour revenir à l'app Movix d'origine : `git checkout -- app && git clean -fd app/src/injection`.

Le scheme et le produit gardent le nom technique `Movix.app` (le script d'empaquetage du dépôt l'exige) ; seuls le nom affiché sur l'écran d'accueil, l'identifiant et les icônes changent.

## Installer l'IPA (non signée)

Comme pour l'app Movix iOS : l'IPA n'est pas signée, il faut la signer avec son propre identifiant Apple.

- **SideStore / AltStore** (recommandé) : importer l'IPA dans le store, qui la signe avec le compte Apple de l'utilisateur. Compte gratuit : 3 apps maximum, re-signature automatique tous les 7 jours.
- **Scarlet** : certificat d'entreprise partagé, pas de limite, mais toutes les apps cessent de s'ouvrir quand Apple révoque le certificat.
- **TestFlight / App Store** : nécessite un compte Apple Developer (99 $/an) et une relecture Apple — peu réaliste pour ce type d'app.

Pour une source AltStore/SideStore dédiée à MEWFLIX (installation en un tap), reprendre `app/scripts/generate-ios-source.mjs` avec l'identifiant `com.mewflix.app` : non fait ici, le job de release Movix existant commite l'IPA dans le dépôt, ce qui ne convient pas tant que la branche n'est pas fusionnée.

## Différences avec l'app de bureau

- Pas de bloqueur réseau EasyList (l'app mobile n'en a pas) : les popups pub sont neutralisés par le mode auto du site et le pont, mais pas les scripts de régies.
- DNS 1.1.1.1 natif (réglage de l'app mobile) à la place du DoH Electron.
- Le proxy média local et le Cast (AirPlay/Chromecast) de l'app mobile restent disponibles.
- Android : `apply-branding.mjs` renomme aussi l'app (`app_name`, `applicationId`) ; les icônes Android (`mipmap-*`) ne sont pas régénérées.

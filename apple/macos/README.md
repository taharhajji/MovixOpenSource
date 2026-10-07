# MEWFLIX pour macOS

C'est exactement l'app de bureau Windows (`desktop/`, Electron), compilée pour macOS. Mêmes fonctions : site live, extension intégrée, blocage des pubs, DNS sécurisé, identité MEWFLIX, VIP local, SwiftFlux relégué.

## Construire sur un Mac

```bash
cd desktop
npm ci
npm run build:mac
```

Produit dans `desktop/dist/` :

| Fichier | Pour |
| --- | --- |
| `MEWFLIX-1.0.0-mac-arm64.dmg` | Mac Apple Silicon (M1 et suivants) |
| `MEWFLIX-1.0.0-mac-x64.dmg` | Mac Intel |
| `MEWFLIX-1.0.0-mac-arm64.zip` / `…-x64.zip` | Mêmes apps, en archive (mise à jour auto) |
| `latest-mac.yml` | Manifeste de l'auto-updater |

L'icône `.icns` est dérivée automatiquement de `desktop/build/icon.png` par electron-builder.

## Construire sans Mac : GitHub Actions

Le workflow `Desktop macOS` (`.github/workflows/desktop-macos.yml`) tourne sur un runner macOS : lancement manuel depuis l'onglet Actions, ou automatiquement sur un tag `desktop-v*` (il attache alors les fichiers à la release GitHub, à côté des exe Windows). Les fichiers sont dans les artefacts du run.

## Premier lancement (app non signée)

Sans certificat Apple Developer, macOS affiche « MEWFLIX ne peut pas être ouvert car il provient d'un développeur non identifié ». Deux solutions :

- clic droit sur l'app › **Ouvrir** › Ouvrir (une seule fois) ;
- ou dans le Terminal : `xattr -dr com.apple.quarantine /Applications/MEWFLIX.app`.

Pour supprimer l'avertissement définitivement, il faut signer et notariser avec un compte Apple Developer (99 $/an) : renseigner `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` dans les secrets du dépôt et passer `hardenedRuntime` à `true` dans `desktop/package.json` › `build.mac`.

## Mises à jour automatiques

L'app lit `latest-mac.yml` à la même URL que Windows (`desktop/release/`). Le script `desktop/scripts/release-manifest.mjs` ne génère aujourd'hui que le manifeste Windows : pour activer l'auto-update macOS, publier `latest-mac.yml` au même endroit (le workflow l'attache déjà à la release).

## Données locales

`~/Library/Application Support/MEWFLIX/` (config.json, cache des filtres, session). Les options `--site=`, `--adblock=off`, `--secure-dns=off`, `--local-vip=off`, `--swiftflux=keep` et les variables `MOVIX_*` sont identiques à Windows.

# MEWFLIX — versions macOS et iOS

> **Décision du 7 octobre 2026 : la version iOS est abandonnée au profit de la version web** ([`web/`](../web/README.md)), qui s'ouvre dans Safari/Chrome sur mobile et s'ajoute à l'écran d'accueil. Le dossier `ios/` reste disponible si l'idée revient, mais n'est plus maintenu.
>
> **macOS** se construit aussi depuis Linux (WSL ou CI Ubuntu) avec `desktop/scripts/build-mac-wsl.sh` : cible `zip` uniquement (le DMG exige `sips`, outil macOS). Les archives produites ici : `desktop/dist-mac/`.

Ce dossier regroupe tout ce qu'il faut pour produire MEWFLIX sur les plateformes Apple. Un point à savoir avant tout : **Apple impose un Mac pour compiler** (Xcode pour iOS, et le `.app` macOS d'Electron contient des liens symboliques que Windows ne sait pas créer). Rien ici ne se construit depuis Windows ; tout se construit en un clic sur un Mac, ou automatiquement par GitHub Actions sur un runner macOS.

| Plateforme | Base | Comment la produire | Résultat |
| --- | --- | --- | --- |
| macOS | La même app Electron que Windows (`desktop/`) | Sur un Mac : `cd desktop && npm ci && npm run build:mac` — ou le workflow `Desktop macOS` | `MEWFLIX-1.0.0-mac-arm64.dmg` (Apple Silicon), `…-mac-x64.dmg` (Intel) + zips |
| iOS | L'app mobile React Native du dépôt (`app/`), habillée MEWFLIX | Le workflow `iOS MEWFLIX unsigned IPA` — ou sur un Mac : `node apple/ios/apply-branding.mjs` puis le build Xcode habituel | `MEWFLIX-unsigned.ipa`, à installer via SideStore / AltStore |

Détails par plateforme : [`macos/README.md`](macos/README.md) et [`ios/README.md`](ios/README.md).

## Ce qui est commun aux trois plateformes

- **Même identité** : nom, icône (générée depuis `desktop/build/logo-source.jpg`), couleurs, définies dans `desktop/src/branding.js`.
- **Mêmes retouches de site** : marque Movix masquée dans la page, popup « voir une pub » en mode auto, statut VIP local, source SwiftFlux reléguée (plus de vérification « robot » au lancement tant qu'une autre source existe). Le code est unique (`desktop/src/injection/site-tweaks.js`) : le bureau l'injecte directement, l'app iOS en reçoit une copie générée par `apple/ios/apply-branding.mjs`.
- **Extension Movix intégrée** (userscript + pont natif) sur chaque plateforme : Electron pour Windows/macOS, le pont React Native existant pour iOS.

## Ce qui diffère

- **Blocage des pubs** : sur macOS c'est le même moteur que Windows (EasyList/EasyPrivacy). Sur iOS, l'app mobile n'a pas de bloqueur réseau ; les popups pub sont neutralisés par le mode auto du site et la fenêtre factice du pont, mais les scripts de régies ne sont pas filtrés.
- **DNS sécurisé** : macOS reprend le DoH de l'app bureau ; iOS a déjà son DNS 1.1.1.1 natif (réglage de l'app mobile).
- **Installation** : macOS non signé = clic droit › Ouvrir au premier lancement. iOS non signé = signature par SideStore/AltStore avec l'identifiant Apple de l'utilisateur (3 apps max sur compte gratuit, re-signature tous les 7 jours), ou certificat d'entreprise via Scarlet.

## Publier une release

- macOS : le workflow `Desktop macOS` se déclenche sur le même tag `desktop-v*` que Windows et attache les `.dmg`/`.zip` à la même release GitHub.
- iOS : tag `mewflix-ios-v*` (ou lancement manuel du workflow) → artefact `MEWFLIX-unsigned-<version>-<run>` à télécharger depuis l'onglet Actions.

Les workflows sont dans `.github/workflows/desktop-macos.yml` et `.github/workflows/ios-mewflix-unsigned.yml`.

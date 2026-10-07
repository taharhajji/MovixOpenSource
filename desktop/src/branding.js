'use strict';

/**
 * Identité de l'application de bureau — volontairement dissociée du site
 * qu'elle charge. Tout ce que l'utilisateur voit (nom de fenêtre, menus,
 * pages locales, boîtes de dialogue, nom de l'exe via package.json) part d'ici.
 *
 * Pour renommer l'app : modifier ce fichier ET les champs `name`,
 * `productName`, `build.appId`, `build.nsis.shortcutName` de package.json
 * (electron-builder ne lit pas ce module), puis `npm run icon` si l'icône
 * doit changer.
 */

module.exports = Object.freeze({
  APP_NAME: 'Orbit',
  TAGLINE: 'Lecteur de streaming',
  APP_ID: 'com.orbit.player',
  // Suffixe du User-Agent : identifie les sessions bureau côté API sans
  // mentionner le site. Reconnu par API/Mainapi/utils/sessionDeviceInfo.js.
  UA_TOKEN: 'OrbitDesktop',
  ACCENT: '#6366f1',
  ACCENT_SOFT: '#a5b4fc',
  BACKGROUND: '#07070b',
  LICENSE_LINE: 'Licence CC BY-NC 4.0',
});

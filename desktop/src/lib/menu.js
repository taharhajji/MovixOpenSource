'use strict';

const { Menu } = require('electron');

/**
 * Menu de l'application (masqué par défaut : touche Alt pour l'afficher).
 *
 * @param {object} actions
 * @param {() => void} actions.reload
 * @param {() => void} actions.home
 * @param {() => void} actions.back
 * @param {() => void} actions.forward
 * @param {{ label: string, url: string }[]} actions.mirrors
 * @param {string} actions.currentMirrorUrl
 * @param {(url: string) => void} actions.selectMirror
 * @param {() => void} actions.refreshMirrors
 * @param {() => void} actions.checkUpdates
 * @param {(url: string) => void} actions.openExternal
 * @param {() => void} actions.about
 * @param {() => void} actions.openConfigFolder
 * @param {string} actions.githubUrl
 * @param {string} actions.telegramUrl
 * @param {boolean} actions.siteForced
 * @param {boolean} actions.adBlockEnabled
 * @param {(enabled: boolean) => void} actions.toggleAdBlock
 */
function buildMenu(actions) {
  const mirrorItems = actions.mirrors.map((mirror) => ({
    label: mirror.label,
    type: 'radio',
    checked: mirror.url === actions.currentMirrorUrl,
    enabled: !actions.siteForced,
    click: () => actions.selectMirror(mirror.url),
  }));

  const template = [
    {
      label: 'Movix',
      submenu: [
        { label: 'Accueil', accelerator: 'Alt+Home', click: actions.home },
        { label: 'Recharger', accelerator: 'CmdOrCtrl+R', click: actions.reload },
        { label: 'Page précédente', accelerator: 'Alt+Left', click: actions.back },
        { label: 'Page suivante', accelerator: 'Alt+Right', click: actions.forward },
        { type: 'separator' },
        {
          label: actions.siteForced ? 'Miroir (site imposé par la config)' : 'Miroir',
          submenu: [
            ...mirrorItems,
            { type: 'separator' },
            { label: 'Actualiser la liste des miroirs', click: actions.refreshMirrors },
          ],
        },
        { type: 'separator' },
        {
          label: 'Bloquer les publicités (phase de test)',
          type: 'checkbox',
          checked: actions.adBlockEnabled,
          click: (item) => actions.toggleAdBlock(item.checked),
        },
        { type: 'separator' },
        { label: 'Ouvrir le dossier de configuration', click: actions.openConfigFolder },
        { type: 'separator' },
        { label: 'Quitter', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Plein écran', role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: 'Zoom avant', role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { label: 'Zoom arrière', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: 'Zoom normal', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { label: 'Outils de développement', role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { label: 'Annuler', role: 'undo' },
        { label: 'Rétablir', role: 'redo' },
        { type: 'separator' },
        { label: 'Couper', role: 'cut' },
        { label: 'Copier', role: 'copy' },
        { label: 'Coller', role: 'paste' },
        { label: 'Tout sélectionner', role: 'selectAll' },
      ],
    },
    {
      label: 'Aide',
      submenu: [
        { label: 'Vérifier les mises à jour', click: actions.checkUpdates },
        { type: 'separator' },
        { label: 'Telegram Movix', click: () => actions.openExternal(actions.telegramUrl) },
        { label: 'Code source (GitHub)', click: () => actions.openExternal(actions.githubUrl) },
        { label: 'Signaler un problème', click: () => actions.openExternal(`${actions.githubUrl}/issues`) },
        { type: 'separator' },
        { label: 'À propos de Movix', click: actions.about },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };

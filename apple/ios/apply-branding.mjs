#!/usr/bin/env node
/**
 * Habille l'app mobile React Native (app/) aux couleurs de MEWFLIX, pour en
 * produire la version iOS (et Android) de l'app de bureau :
 *
 *  - nom affiché « MEWFLIX » (app.json, Info.plist, strings.xml) ;
 *  - identifiant com.mewflix.app (pbxproj, build.gradle) ;
 *  - jeu d'icônes iOS (apple/ios/AppIcon.appiconset, généré par make-icons.cjs) ;
 *  - CONFIG.APP_NAME dans app/src/config ;
 *  - injection des mêmes retouches de site que le bureau (marque masquée,
 *    popup pub en mode auto, statut VIP local, SwiftFlux relégué), générées
 *    depuis desktop/src/injection/site-tweaks.js et branchées dans
 *    app/src/injection/inject.ts avant le userscript.
 *
 * Idempotent : relançable sans effet de bord. Pour revenir à Movix :
 *   git checkout -- app && git clean -fd app/src/injection
 *
 * Usage : node apple/ios/apply-branding.mjs [--check]
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const APP = join(ROOT, 'app');
const BRAND = require(join(ROOT, 'desktop', 'src', 'branding.js'));
const { buildSiteTweaks } = require(join(ROOT, 'desktop', 'src', 'injection', 'site-tweaks.js'));

const BUNDLE_ID = 'com.mewflix.app';
const CHECK = process.argv.includes('--check');
let changed = 0;

function patchFile(file, transform, label) {
  // Un fichier généré peut ne pas exister encore : on part d'un contenu vide.
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = transform(before);
  if (after === before) {
    console.log(`  = ${label} (déjà à jour)`);
    return;
  }
  changed += 1;
  if (CHECK) {
    console.log(`  ! ${label} (dérive)`);
    return;
  }
  writeFileSync(file, after, 'utf8');
  console.log(`  ✓ ${label}`);
}

console.log(`[apply-branding] ${BRAND.APP_NAME} → ${APP}`);

// 1. Nom affiché et identifiants
patchFile(join(APP, 'app.json'), (s) => {
  const json = JSON.parse(s);
  json.displayName = BRAND.APP_NAME;
  return `${JSON.stringify(json, null, 2)}\n`;
}, 'app.json displayName');

patchFile(join(APP, 'ios', 'Movix', 'Info.plist'), (s) => s.replace(
  /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
  `$1${BRAND.APP_NAME}$2`,
), 'Info.plist CFBundleDisplayName');

patchFile(join(APP, 'ios', 'Movix.xcodeproj', 'project.pbxproj'), (s) => s.replace(
  /PRODUCT_BUNDLE_IDENTIFIER = com\.movix\.app;/g,
  `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`,
), 'pbxproj bundle identifier');

patchFile(join(APP, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), (s) => s.replace(
  /(<string name="app_name">)[^<]*(<\/string>)/,
  `$1${BRAND.APP_NAME}$2`,
), 'Android app_name');

patchFile(join(APP, 'android', 'app', 'build.gradle'), (s) => s.replace(
  /applicationId "com\.movix\.app"/,
  `applicationId "${BUNDLE_ID}"`,
), 'Android applicationId');

patchFile(join(APP, 'src', 'config', 'index.ts'), (s) => s.replace(
  /APP_NAME: '[^']*'/,
  `APP_NAME: '${BRAND.APP_NAME}'`,
), 'CONFIG.APP_NAME');

// 2. Icônes iOS
const iconSrc = join(__dirname, 'AppIcon.appiconset');
const iconDst = join(APP, 'ios', 'Movix', 'Images.xcassets', 'AppIcon.appiconset');
if (existsSync(iconSrc)) {
  const files = readdirSync(iconSrc).filter((f) => f.endsWith('.png'));
  let copied = 0;
  for (const file of files) {
    const src = join(iconSrc, file);
    const dst = join(iconDst, file);
    const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
    if (same) continue;
    copied += 1;
    if (!CHECK) {
      mkdirSync(iconDst, { recursive: true });
      copyFileSync(src, dst);
    }
  }
  changed += copied;
  console.log(copied ? `  ${CHECK ? '!' : '✓'} icônes iOS (${copied}/${files.length} fichiers)` : '  = icônes iOS (déjà à jour)');
} else {
  console.log('  ! icônes iOS absentes : lancez make-icons.cjs d’abord');
}

// 3. Retouches de site (même code que le bureau)
const tweaks = buildSiteTweaks({
  appName: BRAND.APP_NAME,
  accent: BRAND.ACCENT,
  hideSiteBranding: true,
  localVip: true,
  adPopupAutoExpr: 'true',
  swiftfluxSource: 'last',
  storagePrefix: 'mewflix_mobile',
});
const escaped = tweaks.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
patchFile(join(APP, 'src', 'injection', 'site-tweaks-source.ts'), () => `/**
 * Retouches de site MEWFLIX (marque masquée, popup pub auto, VIP local,
 * SwiftFlux relégué). AUTO-GÉNÉRÉ par apple/ios/apply-branding.mjs depuis
 * desktop/src/injection/site-tweaks.js — ne pas modifier à la main.
 */

export const SITE_TWEAKS_SOURCE = \`${escaped}\`;
`, 'site-tweaks-source.ts');

patchFile(join(APP, 'src', 'injection', 'inject.ts'), (s) => {
  if (s.includes('SITE_TWEAKS_SOURCE')) return s;
  return s
    .replace(
      "import { USERSCRIPT_SOURCE } from './userscript-source';",
      "import { USERSCRIPT_SOURCE } from './userscript-source';\nimport { SITE_TWEAKS_SOURCE } from './site-tweaks-source';",
    )
    .replace(
      '// --- Userscript Movix ---',
      '// --- Retouches de site MEWFLIX (avant le userscript) ---\n${SITE_TWEAKS_SOURCE}\n\n// --- Userscript Movix ---',
    );
}, 'inject.ts (branchement des retouches)');

if (CHECK && changed) {
  console.error(`[apply-branding] ${changed} élément(s) à appliquer`);
  process.exit(1);
}
console.log(`[apply-branding] terminé (${changed} modification(s))`);

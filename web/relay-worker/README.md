# Relais média MEWFLIX — Cloudflare Worker

Même code que la fonction Edge Vercel `web/api/media.js`, hébergé sur
Cloudflare Workers : **aucun quota de bande passante**, 100 000 requêtes par
jour sur l'offre gratuite (≈ 110 heures de lecture par jour, tous spectateurs
confondus). À utiliser dès que le site a de vrais spectateurs : sur Vercel
(offre Hobby), chaque octet vidéo relayé compte dans le quota « Fast Origin
Transfer » (10 Go/mois), et un dépassement peut mettre tout le projet en pause.

## Mise en route (5 minutes, un compte Cloudflare gratuit suffit)

```bash
cd web/relay-worker
npm install
npx wrangler login                      # ouvre le navigateur
npm run deploy                          # → https://mewflix-media-relay.<compte>.workers.dev
npm run secret                          # colle la valeur de MEDIA_RELAY_SECRET (web/.env.relay.local)
```

Puis côté Vercel, une variable d'environnement et un redéploiement :

```bash
cd web
printf 'https://mewflix-media-relay.<compte>.workers.dev' | npx vercel env add MEDIA_RELAY_BASE production
npx vercel build --prod && npx vercel deploy --prebuilt --prod
```

Résultat : `/media/*` sur Vercel redirige (302) vers le Worker, et le relais
`/api/*` signe directement les adresses de flux vers lui. La page `/status`
affiche « Relais externe ».

## Vérifier

```bash
curl -s https://mewflix-media-relay.<compte>.workers.dev/health
```

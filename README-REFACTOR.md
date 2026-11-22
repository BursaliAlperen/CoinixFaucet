# CoinixFaucet — safe refactor branch

This branch is a staged refactor. It does not deploy, change Render settings, or alter the default branch.

## Layout
- `Frontend/index.html`: preserved copy of the existing UI.
- `Backend/server.js`: Node 20 API and static-file server.
- Root-level legacy files remain untouched for compatibility while migration is reviewed.

## Local checks
```bash
npm run check
npm start
```

## Required Render environment
Set these only in the existing Render service's Environment page:
- `BOT_TOKEN`
- `PIARFLOW_API_KEY`
- `APP_ORIGIN` = the exact existing Render custom domain (no trailing slash)
- `PORT` is supplied by Render automatically

Do not put secrets in frontend files, GitHub, or chat.

## Security status / migration notes
- Telegram Mini App initData is verified server-side with a 5-minute freshness window.
- PiarFlow credentials remain server-side.
- API requests have a per-user rate limit and body-size limit.
- The old frontend still contains legacy Firebase balance, spin, market, and withdrawal writes. Those flows are NOT yet safe to enable in production. They must be migrated to authenticated server endpoints with Firebase Admin transactions and server-side idempotency before replacing the current Render start command.
- TON Connect is not activated yet. A valid `tonconnect-manifest.json` must use the exact production domain and a hosted icon. The domain is intentionally not guessed.
- No automatic wallet payout is enabled. Wallet connection alone is not proof of ownership; payout requires a verified TON wallet signature / transaction flow and server-side validation.

## Deployment
No deployment was performed. Do not switch the existing Render service to this branch until the remaining Firebase and TON Connect migration is complete and tested.

# Environment variables

Set these in Render > Service > Environment. Do not commit real values.

| Variable | Purpose |
|---|---|
| BOT_TOKEN | Telegram bot token |
| BOT_USERNAME | Bot username without @ |
| ADMIN_IDS | Comma-separated numeric Telegram admin IDs |
| ANNOUNCEMENT_CHANNEL_ID | Channel @username or numeric -100... ID |
| BOT_WEBHOOK_SECRET | Random secret for Telegram webhook verification |
| PUBLIC_BASE_URL | Exact public HTTPS Render service origin |
| WEBAPP_URL | HTTPS URL configured as Telegram Mini App |
| APP_ORIGIN | Exact public HTTPS origin; no trailing slash |
| FIREBASE_SERVICE_ACCOUNT | Firebase service account JSON or base64 JSON |
| FIREBASE_DATABASE_URL | Exact Realtime Database URL from the same Firebase project |
| PIARFLOW_API_KEY | Optional PiarFlow server key |
| FLYERHUBS_KEY | FlyerHubs bot key for task integration |
| MONETAG_POSTBACK_SECRET | Secret query parameter used in Monetag postback URL |
| MONETAG_ZONE_ID | Optional zone allowlist/reference for Monetag |
| REWARD_TIMEZONE | Defaults to Europe/Istanbul |
| PORT | Supplied by Render |

Required Render commands:
- Build: `npm install`
- Start: `npm start`
- Health path: `/health`
- Node: 20+

The Firebase client config already in Frontend/js/app.js identifies the public Firebase project. FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL must belong to that same project. Never copy a service account into frontend JavaScript.

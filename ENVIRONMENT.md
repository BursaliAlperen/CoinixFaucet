# Environment setup

Configure values in the Render service's Environment settings. Never commit real secrets.

| Name | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | Yes | Telegram bot token; used only on the backend. |
| `FIREBASE_SERVICE_ACCOUNT` | Yes | Full service-account JSON or base64-encoded JSON. Keep private. |
| `FIREBASE_DATABASE_URL` | Yes | Exact Firebase Realtime Database URL. |
| `APP_ORIGIN` | Yes | Exact HTTPS origin, e.g. `https://your-app.onrender.com`, without trailing slash. Required for browser API origin validation. |
| `PIARFLOW_API_KEY` | Sponsor tasks | PiarFlow API key; stored server-side. |
| `REWARD_TIMEZONE` | Optional | Defaults to `Asia/Dhaka` to preserve the legacy reward-day behavior. |
| `PORT` | Render supplied | Do not hardcode a public port. |

## Render commands
- Build: `npm install`
- Start: `npm start`
- Health check path: `/health`

## Telegram task verification
Add the bot to each rewarded Telegram channel/group with enough permissions for `getChatMember` to verify membership. Unsupported task types do not receive rewards.

## Firebase
1. Confirm the service-account project matches the existing Firebase project.
2. Confirm the Realtime Database URL and region.
3. Review and deploy the included database and Firestore rules only after checking other consumers.
4. Ensure Authentication is enabled so Firebase custom-token sign-in can work.

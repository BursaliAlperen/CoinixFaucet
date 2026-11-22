# CoinixFaucet

Node.js 20+ backend and mobile-first Telegram Mini App frontend.

## Structure
- `Backend/server.js` — Telegram initData verification, Firebase Admin, economy actions, PiarFlow proxy, static hosting.
- `Frontend/index.html` — application markup.
- `Frontend/assets/app.css` — application styles.
- `Frontend/js/app.js` — client UI and Firebase read subscriptions.
- `firebase.database.rules.json` / `firestore.rules` — deny-by-default client security rules.

## Render settings
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Node version: 20+

Set these environment variables in Render (not in GitHub): `BOT_TOKEN`, `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_DATABASE_URL`, `APP_ORIGIN`. Add `PIARFLOW_API_KEY` for sponsor tasks. `FIREBASE_SERVICE_ACCOUNT` accepts the service-account JSON or its base64 encoding. Give the service account only the Firebase permissions this application needs.

## Firebase security migration
Deploy the rules in `firebase.database.rules.json` and `firestore.rules` to the matching Firebase project only after checking that other apps/admin clients do not depend on broader access. Admin SDK writes bypass client rules. The frontend signs in with the short-lived custom token returned by `/api/session`; the browser must never receive the service-account key.

## Economy API
All balance-changing actions are handled by `POST /api/economy` and are checked against server-side Firebase data/settings. Supported actions: `daily_card`, `task`, `checkin`, `spin`, `buy_cards`, `withdraw`. Ad rewards are intentionally not credited by a browser callback; integrate a provider-verifiable server callback before enabling them. Sponsor rewards are credited only after the PiarFlow check reports `subscribed` and are idempotent per sponsor link.

## Important
- This refactor branch is not deployed and does not modify `main` or any Render service.
- Wallet connection / TON Connect is not enabled yet. A production manifest requires the exact final HTTPS domain and hosted icon URL.
- Review the Firebase rules against the live project's data model before applying them. No payout automation is enabled by this refactor.

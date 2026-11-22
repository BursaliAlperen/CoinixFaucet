# CoinixFaucet — AAA project setup

## Current architecture

- Telegram Bot API webhook: `Backend/server.js`
- Telegram Mini App: `Frontend/index.html`, `Frontend/js/app.js`, `Frontend/assets/app.css`
- Admin Mini App: `Frontend/admin.html`, `Frontend/js/admin.js`
- Local inline SVG icon system: `Frontend/js/icons.js`
- Firebase Realtime Database: user profiles, settings, tasks, referrals, notifications, withdrawal queue
- Firestore: immutable transaction history
- Railway: Node.js hosting and webhook endpoint

## Reward policy

- API-verified Piarflow sponsor completion: **$0.002**
- API-verified FlyerHubs task completion: **$0.002**
- Monetag valued server postback: **$0.002**
- API reward is fixed and does not receive the level multiplier.
- Regular Firebase-admin-created tasks keep their own configured reward. Do not mistake them for provider API tasks.
- Traffy has a key configured, but no verified public publisher API contract has been integrated. Do not credit users from an unverified callback or guess an endpoint. Add it only after its official API documentation or a working authenticated request/response example is supplied.

## Payout policy

- Only the lowercase Firebase method keys `withdrawMethods/ton` and `withdrawMethods/gram` are accepted.
- The server creates default TON and GRAM method records when a user profile is bootstrapped; an existing inactive method remains inactive.
- Papara and all other methods are rejected by the server even if an old record remains in Firebase.
- User balance is accounted in USD. A withdrawal request reserves/debits that USD amount and stores the selected currency plus wallet address.
- Admin payout is deliberately manual: send the corresponding TON or GRAM token from the operator wallet, then enter the actual coin amount and transaction hash in the admin panel. The app does not send blockchain transactions automatically and must not claim that it does.
- Rejecting a pending request returns its USD amount to the user once. A refund marker prevents duplicate refunds.
- GRAM means the token on the TON network. Confirm the intended token contract and payout wallet before enabling real GRAM transfers; do not substitute another token with a similar ticker.

## Required Railway environment variables

### Telegram and service
- `BOT_TOKEN` — secret BotFather token
- `BOT_USERNAME`
- `ADMIN_IDS` — comma-separated Telegram numeric IDs
- `BOT_WEBHOOK_SECRET` — secret webhook header token
- `PUBLIC_BASE_URL`, `WEBAPP_URL`, `APP_ORIGIN` — Railway service origin
- `PORT=3000`, `NODE_ENV=production`

### Firebase
- `FIREBASE_SERVICE_ACCOUNT` — secret service-account JSON
- `FIREBASE_DATABASE_URL` — exact Realtime Database URL
- `FIREBASE_WEB_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_STORAGE_BUCKET`
- `FIREBASE_MEASUREMENT_ID` — optional

All Firebase web values must come from the same Firebase project as the service-account JSON and Realtime Database. The frontend obtains the public web configuration from `/public-config/firebase`; no stale project config is hardcoded into the browser bundle.

### Ad providers
- `PIARFLOW_API_KEY`
- `FLYERHUBS_KEY`
- `TRAFFY_API_KEY` — stored only; integration is pending official API details
- `MONETAG_ZONE_ID`
- `MONETAG_POSTBACK_SECRET`

### Other
- `REWARD_TIMEZONE=Europe/Istanbul`
- `TELEGRAM_INIT_DATA_MAX_AGE_SECONDS=86400`

Never place secrets in GitHub files, frontend JavaScript, or client-side Firebase settings.

## Firebase security rules

The repository contains:
- `firebase.database.rules.json`
- `firestore.rules`
- `firestore.indexes.json`
- `firebase.json`

Deploy them to the same Firebase project as the service account. RTDB client access is read-only and limited to the authenticated user's own profile plus public app configuration collections. Firestore transaction reads are restricted to the authenticated user's own transaction records. All balance, reward, referral, withdrawal, and admin writes must pass through the backend.

## Verification

Run:

```bash
npm run check
```

Then verify:
1. `GET /health` returns `firebaseAdminConfigured: true` and `firebaseWebConfigConfigured: true`.
2. `GET /public-config/firebase` returns the expected project config, without secrets.
3. Open the Mini App from the Telegram bot and verify session + profile bootstrap.
4. Complete one provider task and verify exactly $0.002 is credited once.
5. Submit a TON and a GRAM test withdrawal using valid test wallets.
6. Mark one request paid with a transaction hash; reject another and confirm the USD balance is refunded once.
7. Confirm Papara and arbitrary method keys are rejected.

## Known external dependencies

- Firebase project web-app config and exact RTDB URL must be supplied from Firebase Console.
- Traffy API cannot be safely implemented from an API key alone; its official publisher API docs or an authenticated request/response sample is required.
- Automatic blockchain payouts require a separately secured operator wallet signer, fee policy, chain/token contract configuration, idempotent payout ledger, and operational approval. The current panel records a manually sent payout and its transaction hash.

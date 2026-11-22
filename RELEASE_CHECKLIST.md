# Release checklist

Do not deploy this branch until every required item is checked.

## Render
- [ ] Create/update the Web Service from refactor/backend-frontend only after review.
- [ ] Runtime Node 20+.
- [ ] Build command: npm install.
- [ ] Start command: npm start.
- [ ] Health check path: /health.
- [ ] Set BOT_TOKEN, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, APP_ORIGIN.
- [ ] Set PIARFLOW_API_KEY only if sponsor tasks are enabled.
- [ ] Confirm APP_ORIGIN exactly matches the public HTTPS origin.

## Firebase
- [ ] Confirm the service account and database URL point to the existing Coinix Firebase project.
- [ ] Back up Realtime Database and Firestore before changing rules.
- [ ] Review firebase.database.rules.json against any other apps using this Firebase project.
- [ ] Review firestore.rules and firestore.indexes.json.
- [ ] Deploy reviewed rules and indexes to the correct Firebase project.
- [ ] Confirm Firebase Authentication custom-token sign-in is enabled.
- [ ] Confirm the bot can verify membership in each rewarded Telegram channel/group.

## Product integrations
- [ ] Validate PiarFlow API responses using a test Telegram account.
- [ ] Keep ad rewards disabled until provider-signed callbacks are implemented.
- [ ] Implement admin withdrawal review and payout execution before accepting real withdrawals.
- [ ] Configure TON Connect only after confirming the production domain and wallet manifest icon URL.

## Final smoke test
- [ ] Telegram /start and Mini App launch.
- [ ] New user bootstrap and existing user sign-in.
- [ ] Referral signup and one-time referral credit.
- [ ] Daily card, check-in, spin, card purchase, and task membership verification.
- [ ] Sponsor list and one-time sponsor reward.
- [ ] Withdrawal request, balance debit, and rollback on persistence failure.
- [ ] Leaderboard, referral list, and transaction history.
- [ ] Verify that a normal browser cannot call API endpoints without fresh Telegram initData.

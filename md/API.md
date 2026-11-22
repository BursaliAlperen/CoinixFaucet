# Backend API

Authenticated application endpoints use POST JSON and a fresh Telegram Mini App initData value. User identity is always taken from validated initData, never from a client-supplied user ID.

## Session
- POST /api/session — verifies Telegram, creates/loads the user, returns a Firebase custom token, admin flag and bot username.

## Economy
- POST /api/economy — daily_card, checkin, spin, buy_cards, task, withdraw.
- Rewards are calculated server-side and written through Firebase Admin transactions.
- Check-in gives 10 XP by default.
- Standard tasks give 20 XP by default.
- Rewards use the server-side multiplier `1 + (level × 0.02)`, capped at 2.00× at Level 50.

## Tasks and ads
- POST /api/flyerhubs/tasks — fetches up to 10 user tasks from FlyerHubs.
- POST /api/flyerhubs/check — checks a FlyerHubs signature with the provider and credits only a completed task.
- GET /postback/monetag — Monetag server-to-server valued impression callback. Uses MONETAG_POSTBACK_SECRET and unique ymid; browser callbacks never credit balances.

## Admin
All endpoints below require the Telegram user ID to be included in ADMIN_IDS:
- POST /api/admin/overview
- POST /api/admin/promo — saves a promotion and automatically publishes it to ANNOUNCEMENT_CHANNEL_ID.
- POST /api/admin/settings — updates the allowlisted economy and XP settings.

## Telegram
- POST /telegram/webhook — Telegram webhook protected by BOT_WEBHOOK_SECRET.
- GET /health — non-sensitive integration readiness only.

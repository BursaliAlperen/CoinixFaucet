# Release checklist

## Render
- [ ] Confirm whether Starter ($7/month at current published pricing) is acceptable for always-on service.
- [ ] Create Web Service from branch refactor/backend-frontend, region Frankfurt.
- [ ] Build npm install; start npm start; health path /health.
- [ ] Set all required environment variables in Render.
- [ ] Set PUBLIC_BASE_URL, WEBAPP_URL and APP_ORIGIN to the exact Render URL.
- [ ] Add custom domain only after DNS is verified.

## Telegram
- [ ] Set BOT_TOKEN, BOT_USERNAME, BOT_WEBHOOK_SECRET, ADMIN_IDS.
- [ ] Set Mini App URL in BotFather.
- [ ] Add bot as admin in announcement channel.
- [ ] Set ANNOUNCEMENT_CHANNEL_ID.
- [ ] Verify /start, /help, /admin, /botmessages and /yeni.
- [ ] Verify a new referral generates one reward and one notification.

## Firebase
- [ ] Confirm service account and RTDB URL point to the same existing project.
- [ ] Back up Realtime Database and Firestore.
- [ ] Review rules for any other app sharing this Firebase project.
- [ ] Deploy reviewed rules/indexes.
- [ ] Verify custom-token authentication.

## Providers and economy
- [ ] Add FLYERHUBS_KEY and test get_tasks/check_task with a test user.
- [ ] Configure Monetag postback URL and MONETAG_POSTBACK_SECRET.
- [ ] Test valued, non_valued, duplicate ymid and daily-limit cases.
- [ ] Confirm XP progression and level-100 2x multiplier.
- [ ] Confirm promotion creation posts to the announcement channel.
- [ ] Confirm pending withdrawals; do not promise automatic payout.

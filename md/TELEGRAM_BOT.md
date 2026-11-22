# Telegram bot commands and referrals

The backend registers these commands with Telegram when BOT_TOKEN, BOT_WEBHOOK_SECRET and PUBLIC_BASE_URL are configured.

- /start — welcome message and Mini App launch button; accepts referral payloads such as `/start ref_123456789`.
- /help — command help.
- /level — current level, XP progress and Level 100 reward unlock.
- /referrals — referral count, earned amount and personal invite link.
- /admin — admin-only launch button for `/admin`.
- /botmessages — admin-only message tools summary.
- /yeni — admin-only latest referral activity.

## Referral flow
1. The app shares `https://t.me/BOT_USERNAME?start=ref_TELEGRAM_ID`.
2. Telegram delivers the payload to /start.
3. A new account is created once; self-referrals and invalid referrers are rejected.
4. The referrer receives a Firebase in-app notification and a Telegram DM (if they have opened the bot).
5. Referral reward is credited once.

## Setup
- Configure the bot's Mini App URL in BotFather.
- Set WEBAPP_URL and PUBLIC_BASE_URL to the final Render HTTPS URL.
- Set BOT_WEBHOOK_SECRET to a long random value.
- Ensure the bot can message users only after they have started it.
- Set ADMIN_IDS to the exact numeric Telegram IDs of administrators.

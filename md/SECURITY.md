# Security model

- Telegram initData HMAC is validated server-side with a five-minute freshness window.
- API origin is checked against APP_ORIGIN.
- Firebase Admin credentials and provider keys remain server-side.
- Client writes to Firebase are denied by the included rules; Admin SDK performs authoritative writes.
- Economy actions are transaction-based and protected by per-action IDs.
- Monetag rewards are credited only from a server postback marked valued, once per ymid.
- FlyerHubs tasks are checked through the provider's check_task API before reward.
- Admin endpoints require a verified Telegram ID in ADMIN_IDS.
- Telegram webhook requests require the X-Telegram-Bot-Api-Secret-Token header.
- Promotion channel posts are sent by the bot only after an admin-authenticated request.

## Operational cautions
- Back up the existing Firebase project before deploying stricter rules.
- Add the bot as an administrator of ANNOUNCEMENT_CHANNEL_ID with permission to post.
- Never put BOT_TOKEN, Firebase service account JSON, FlyerHubs key, or Monetag secret in frontend files or GitHub.
- Withdrawals remain pending requests. No automated payout or admin approval execution is included.
- Review provider terms, campaign policies, local law and fraud rules before enabling rewards.

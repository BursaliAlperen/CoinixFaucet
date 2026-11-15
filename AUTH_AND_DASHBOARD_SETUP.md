# CoinixFaucet — Sign-in Providers

The site keeps its existing Telegram Mini App authentication and adds browser sign-in options.

## Telegram (free)

1. Use the existing bot configured by `BOT_TOKEN` and `BOT_USERNAME` in Render.
2. Open [@BotFather](https://t.me/BotFather), select the same bot and run `/setdomain`.
3. Set the allowed domain to `coinixfaucet.mine.bz` (without a path).
4. Ensure Render has the matching `BOT_TOKEN` and `BOT_USERNAME` values.
5. Deploy. The Telegram Login Widget sends signed user data to `POST /api/auth/telegram`; the backend verifies the HMAC and rejects data older than 24 hours.

The Telegram Mini App path `POST /api/auth` remains available and unchanged.

## Google (free within Google's standard quotas)

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Configure the OAuth consent screen.
3. Create an OAuth Client ID of type **Web application**.
4. Add `https://coinixfaucet.mine.bz` under Authorized JavaScript origins.
5. Copy the Web Client ID into Render as `GOOGLE_CLIENT_ID`.
6. Deploy and test the Google sign-in button.

The browser receives a Google ID token. The backend verifies its RS256 signature against Google's rotating public JWKS, checks issuer, expiry, exact configured audience and verified email, and then issues the site's own JWT.

## Apple (optional; not fully free)

Sign in with Apple for the web requires a Services ID associated with an enabled primary App ID and registered website/return URL. Apple web configuration is documented at:

https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/

Apple Developer Program membership currently costs USD 99 per year (regional pricing may vary). A free Apple developer account alone does not provide all capabilities needed for production web sign-in.

When the Apple configuration is available, set:
- `APPLE_CLIENT_ID`: the Apple Services ID.
- `APPLE_REDIRECT_URI`: the registered HTTPS return URL (the default in Render is the site origin).

The backend verifies Apple's RS256 identity token against Apple's published JWKS and checks issuer and audience.

## Security and account behavior

- Provider tokens are verified server-side; the browser never chooses a user ID.
- Site sessions are signed with the existing `JWT_SECRET`.
- Do not put bot tokens, OAuth client secrets, or private keys in frontend code.
- Telegram, Google and Apple sign-ins currently create provider-specific user records. They do **not** automatically merge existing accounts or move CNX balances between accounts. Account linking/merging should be added only with a verified, authenticated linking flow.
- Existing Telegram Mini App users continue using their Telegram numeric account ID.

## Dashboard XP and achievements

The dashboard endpoint `GET /api/dashboard/stats` returns the last 14 days of recorded CNX transaction earnings, derived XP/level progress, and achievement states. The chart does not invent past activity. XP is currently computed from stored account totals:
- 10 XP per faucet claim
- 25 XP per referral
- 1 XP per 5 CNX earned

Level thresholds are 250 XP per level. This is a display/progression system and does not itself mint CNX or change withdrawal balances.

# CoinixFaucet — Authentication & Admin Setup

## Sign-in policy
- Telegram Login Widget and Telegram Mini App remain supported.
- Google sign-in is brokered by Firebase Authentication. No standalone Google Identity Services integration remains.
- No email/password login is provided.
- Apple sign-in has been removed.

## Firebase Google setup
1. Open https://console.firebase.google.com/ and select the Firebase project already used by the backend service account.
2. Authentication → Sign-in method → enable **Google**.
3. Project settings → General → register a Web app if needed.
4. Add these Render environment variables from the Firebase Web App config: `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`.
5. Authentication → Settings → Authorized domains → add `coinixfaucet.mine.bz`.
6. Keep `FIREBASE_SERVICE_ACCOUNT_JSON` or `FIREBASE_SERVICE_ACCOUNT_BASE64` on the server only. Never publish the service account key.

The API verifies the Firebase ID token using Firebase Admin SDK and accepts only `google.com` sign-in provider tokens.

## Admin panel
After deployment open: https://coinixfaucet.mine.bz/admin/
Sign in on the main site using the Telegram account whose numeric ID matches `ADMIN_TELEGRAM_ID`. Admin API requests use the signed JWT with the server-verified `is_admin` claim; no admin secret is embedded in the browser.

Required server variables: `ADMIN_TELEGRAM_ID`, `BOT_TOKEN`, `JWT_SECRET`, and Firebase service account JSON/base64.

## Account identities
Telegram and Firebase Google accounts are separate identities. Automatic account merging is not enabled; balances do not transfer between identities.

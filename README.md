# COINIX FAUCET v2.0

## Deployment Instructions

### 1. Firebase Setup
- Go to Firebase Console → Project Settings → Service Accounts
- Generate new private key
- **Rename the downloaded file to `serviceAccountKey.json`**
- Upload it to your project root (same folder as `server.js`)
- **NO Firebase environment variables are needed**

### 2. Environment Variables
Create `.env` file (see `.env.example`):
```
BOT_TOKEN=your_telegram_bot_token
BOT_USERNAME=your_bot_username
ADMIN_ID=your_secret_admin_key
PORT=3000
```

### 3. Install & Run
```bash
npm install
npm start
```

### 4. Firestore Security Rules
Deploy `firestore.rules` in Firebase Console to ensure all client-side access is blocked. All database operations go through the server (Admin SDK).

### 5. Admin Panel
Access: `https://your-domain.com/admin?admin_key=YOUR_ADMIN_ID`

### 6. Telegram Mini App
Set your Mini App URL in @BotFather to point to `https://your-domain.com/`

## What Changed in v2.0
- **Firebase**: Removed all env-based Firebase credentials. Only `serviceAccountKey.json` required.
- **Dashboard**: Simplified to 6 clean stat cards.
- **Admin Panel**: Full-featured admin with users, withdrawals, settings, broadcast, logs.
- **Security**: Added `banned` field, faucet pause, server-side validation, Firestore rules.
- **Settings**: Faucet rewards, cooldown, min withdrawal configurable via admin panel.
- **Code Quality**: Modular, clean, zero placeholders, production-ready.

# Backend API

All API endpoints use same-origin HTTPS POST requests with application/json. The backend verifies Telegram WebApp initData on every request. A client-supplied user ID is never accepted as identity proof.

## Session

POST /api/session accepts initData and an optional referralCode. It returns a Firebase custom token. Sign in with signInWithCustomToken before reading Firebase data.

## Economy

POST /api/economy accepts a unique actionId for each user action.

| Action | Additional fields | Server checks |
|---|---|---|
| daily_card | — | One claim per reward day |
| checkin | — | One claim per day; server-calculated streak |
| spin | — | Ticket balance and server-generated reward |
| buy_cards | count: 1, 5, or 10 | Server price and available balance |
| task | taskId | Task active and Telegram membership verified through Bot API |
| withdraw | amount, method, account | Server method config, limits, balance; creates pending request |

Example request:

    {
      "initData": "<Telegram.WebApp.initData>",
      "actionId": "unique-action-id",
      "action": "checkin"
    }

## Read APIs

- POST /api/leaderboard — limited public leaderboard projection.
- POST /api/referrals — recent referrals for the authenticated user.
- POST /api/sponsors — server-side PiarFlow sponsor list proxy.
- POST /api/sponsors/check — verifies sponsor status and credits a one-time reward server-side.

## Health

GET /health reports process health and whether backend integrations are configured. It does not expose credentials.

## Important limitations

- Monetag rewards remain disabled until a trusted provider callback can be validated server-side.
- Withdrawals are recorded as pending. No automated payout or admin approval workflow is implemented.
- TON Connect / wallet proof is not yet configured.
- Telegram membership tasks require the bot to be able to call getChatMember for the target channel/group.

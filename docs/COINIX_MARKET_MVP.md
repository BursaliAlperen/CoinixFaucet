# Coinix Market MVP

First release supports advertiser-funded Telegram tasks and a provider-neutral offerwall postback contract.

## Important separation
- Existing CNX faucet balances and withdrawals are unchanged.
- COINIX is a separate internal ledger balance (\`users/{uid}.coinixAvailable\`) until a TON Jetton and audited withdrawal flow are implemented.
- No daily bonus, airdrop, client-side reward credit, or automatic token minting is implemented.

## Telegram task flow
1. A signed-in task owner submits a Telegram URL, description, reward per completion, and participant cap.
2. The backend reserves the full budget from the owner's available COINIX balance into escrow.
3. Task enters pending review; an admin activates it after review.
4. A user submits a Telegram username or proof. The submission remains pending.
5. Admin approves or rejects. Approval credits the user's COINIX ledger once.

The MVP uses manual review. Telegram membership verification requires a configured Telegram bot with suitable access and is not assumed here.

## Offerwall callback
POST JSON to \`/api/market/offerwall/postback\`:
\`\`\`json
{"provider":"provider-id","transactionId":"unique-provider-transaction","userId":"firebase-uid","reward":12.5,"status":"completed"}
\`\`\`
Header \`x-coinix-signature\` must be HMAC-SHA256 hex of the exact raw HTTP request body, using \`OFFERWALL_POSTBACK_SECRET\`. Provider-specific adapters must map the provider's macros and signature scheme to this contract. Check provider terms for crypto rewards before enabling it.

## Environment
- \`OFFERWALL_POSTBACK_SECRET\`: long random secret stored only in deployment secrets.
- Existing Firebase Admin configuration is required.
- Never commit secrets or private keys.

## API
- \`GET /api/market/tasks?type=telegram|offerwall\`
- \`POST /api/market/tasks\` (Firebase bearer token)
- \`POST /api/market/tasks/:taskId/submit\` (Firebase bearer token)
- \`POST /api/admin/market/tasks/:taskId/activate\` (existing admin key)
- \`POST /api/admin/market/tasks/:taskId/submissions/:userId/decision\` (existing admin key; decision approve|reject)
- \`POST /api/market/offerwall/postback\` (signed provider server callback)

## Remaining before public launch
Provider-specific integration and terms review, admin queue UI, owner funding/deposit flow, Telegram bot verification, automated tests, and security review. Task creation requires an already funded COINIX balance; no public top-up route is provided.

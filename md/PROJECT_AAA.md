# CoinixFaucet — AAA implementation record

## Product architecture
- Telegram Bot API webhook and Mini App session verification: Backend/server.js
- User Mini App: Frontend/index.html, Frontend/js/app.js, Frontend/assets/app.css
- Admin panel: Frontend/admin.html, Frontend/js/admin.js, Frontend/assets/admin.css
- Local SVG sprite icon renderer: Frontend/js/icons.js
- Firebase RTDB: profiles, tasks, claims, referrals, withdrawals, settings and audit events
- Firestore: append-only transaction history and analytics source
- Node.js 20+ / Railway deployment

## Mandatory Telegram channel
- REQUIRED_CHANNEL_ID and REQUIRED_CHANNEL_URL are required.
- Bot must be an administrator in the channel to use getChatMember reliably.
- /start and Mini App sessions are gated; callback button retries membership.
- Protected API calls recheck membership. Status transitions are stored under channelMembership and channelMembershipEvents.
- Missing channel settings, missing bot rights and Telegram API errors produce safe messages and admin alerts.

## Tasks
- Admin can create tasks with title, description, type, reward, target URL/chat, start/end time, total cap, per-user cap, verification method and status.
- Statuses: draft, active, paused, completed.
- Channel/group tasks use Telegram getChatMember verification.
- Link/manual tasks require proof and enter the admin review queue.
- Claim IDs and user completion ledgers prevent duplicate rewards. Manual approvals use a reviewing lock and persist reward recovery data before marking the claim paid.
- Task participant capacity is reserved transactionally; failed/rejected claims release their slot.
- Global user API throttling and per-task limits reduce abuse.

## Referral bonus
- Each first-time valid referral grants the inviter +0.02x as an additive multiplier bonus, not a cash amount and not a percentage of balance.
- Default duration: 24 hours from startsAt to endsAt.
- The bonus is applied as 1 + (level * 0.02) + sum(active referral bonuses).
- Referral bonus records retain source, invitee, amount, start/end timestamps and status.
- Expired bonuses are ignored by the multiplier immediately and marked expired when the user session is refreshed.
- Admin can configure referralMultiplierBonus (0–0.25) and referralBonusDurationHours (1–168).
- Self-invites and repeated invitee claims are rejected.

## Monetization providers
- Piarflow and FlyerHubs are the existing API-backed integrations. Successful provider verification credits the fixed Coinix amount $0.002 once; this is an in-app reward and does not guarantee provider revenue covers the cost.
- Traffy appears as a provider and personal tracking link is generated when TRAFFY_LINK_PREFIX is configured. Format: https://t.me/Traffy_robot?startapp=l_<prefix>_<telegram_id>.
- Traffy API sync is intentionally disabled until its official endpoint, authentication, pagination, event ID and response schema are confirmed. TRAFFY_API_KEY is read only on the server. Do not credit balances from guessed endpoints or unverified callbacks.
- A generic 300/minute fixed-window limiter, provider error classifier and external-event idempotency primitive are unit-tested for the future Traffy client; no Traffy HTTP calls currently occur.
- Monetag is not used; its runtime integration has been removed.

## Admin and reporting
- Admin access is restricted to ADMIN_IDS.
- Admin can pause/start user access, publish Telegram announcements, configure XP/referral settings, manage tasks, review manual proofs and settle TON/GRAM withdrawals.
- Daily 7/30-day analytics are aggregated from RTDB user records and Firestore transaction records. Filters include provider, task type and Telegram user ID; CSV export is client-generated from the returned real data.
- Important actions are written to adminAudit. Membership transitions and task review history are retained.

## Payouts
- Only TON and GRAM are accepted by the server.
- Papara and unknown methods are rejected.
- Admin manually sends the transfer, then records actual coin amount and transaction hash. No automatic wallet signer is configured.
- Rejected withdrawals refund the original USD balance once.

## Migrations and checks
- Run dry-run: npm run migrate:v3
- Apply additive migration: RUN_MIGRATION=1 npm run migrate:v3
- Migration adds default task/referral fields without changing balances or deleting old records.
- Run: npm run check
- The check command runs reward/task/referral/provider helper tests, Node syntax checks and static smoke checks.

## Required environment
See md/ENVIRONMENT.md and .env.example. Firebase Admin service account, RTDB URL and Firebase Web App config must all belong to the same project. Set REQUIRED_CHANNEL_ID and REQUIRED_CHANNEL_URL. Generate a fresh Traffy key in the provider dashboard; never reuse a key previously pasted into chat.

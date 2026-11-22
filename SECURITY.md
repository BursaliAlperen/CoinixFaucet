# Security architecture

## Authentication
- Telegram Mini App `initData` is verified server-side with HMAC-SHA256.
- Sessions older than five minutes or dated more than 30 seconds in the future are rejected.
- Firebase custom tokens are minted only after Telegram identity verification.

## Economy integrity
- Browser code does not write balances, transactions, withdrawals, referral rewards, check-in rewards, task rewards, or spin rewards directly to Firebase.
- Rewards, card prices, task definitions, and withdrawal methods are loaded by the backend from Firebase.
- Economy mutations use Realtime Database transactions and idempotency keys.
- Withdrawal requests debit the balance on the server and are stored as pending. If writing the request fails, the debit is rolled back.
- Sponsor rewards are credited only after the PiarFlow check reports a subscribed state.
- Browser-only ad callbacks are not trusted. Ad rewards remain disabled until a provider-signed callback can be verified.

## Firebase rules
The proposed rules in `firebase.database.rules.json` and `firestore.rules` deny client writes. Deploy them only after reviewing the live Firebase project and any other apps that use it. Firebase Admin SDK writes bypass these rules.

## Not yet implemented
- Automated payout execution and admin approval workflow.
- TON Connect manifest, wallet proof verification, and wallet payout binding.
- Trusted provider callback for Monetag / rewarded ad completion.
- Automated integration tests against a staging Firebase project.

Do not describe the application as fully production-secure until these remaining workflows are completed and tested.

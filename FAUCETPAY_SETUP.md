# Coinix FaucetPay setup

## Automatic withdrawals

Coinix sends eligible withdrawals from the backend through FaucetPay's scoped v2 API. The API key is never requested in the browser and must never be committed to Git.

1. Open the FaucetPay faucet owner dashboard.
2. Create a scoped API key with the **send** scope. Set a conservative daily USD cap and an IP allowlist if your hosting provider has a stable outbound IP.
3. Add the key to the production service as the secret environment variable `FAUCETPAY_API_KEY`.
4. Redeploy/restart the service and make a small test withdrawal to an account you control.

The backend uses `POST https://faucetpay.io/api/v2/send`, a unique withdrawal document ID as the idempotency key, and the claimant IP for FaucetPay's anti-abuse checks.

## Supported Coinix withdrawal balances

| Coinix balance | FaucetPay currency |
| --- | --- |
| DOGE | DOGE |
| DGB | DGB |
| FEYORRA | FEY |

PEPE and POL are not currently listed as supported FaucetPay payout currencies, so the API rejects withdrawals from those balances instead of silently converting them.

Amounts are converted from the app's coin units to the smallest unit (1 coin = 100,000,000 units) for the supported currencies. The actual payout still depends on FaucetPay's current minimums, account status, and available faucet balance.

## Withdrawal states

- **approved**: FaucetPay confirmed the payout; it appears in successful payout history.
- **processing**: the provider response was interrupted or could not be confirmed. The reserved balance is not automatically refunded, to avoid paying twice. Reconcile this record with the FaucetPay dashboard before taking action.
- **failed**: FaucetPay definitively rejected the payout; Coinix returns the reserved balance to the user.

## Important

- Do not add the API key to `index.html`, frontend JavaScript, or a public config file.
- Keep Firebase credentials, Telegram bot token, JWT secret, and FaucetPay key in hosting secrets only.
- Do not mark a payout as paid manually unless FaucetPay confirms it.
- Test with a small amount before enabling regular withdrawals.

Official API reference: https://faucetpay.io/api-docs

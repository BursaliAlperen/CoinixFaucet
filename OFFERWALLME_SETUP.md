# CoinixFaucet — Offerwall.me Setup

## Placement configuration

Set the Offerwall.me placement currency exactly as follows:

- Currency name: `CNX`
- Currency rounding / decimals: `6`
- Exchange rate: `10000` (10,000 CNX = $1.00 USD)

The placement's **public API key**, **private Secret Key**, and **Bearer Token** are three different credentials. The banner placement ID shown in the banner-code snippet is not the public API key.

## Postback

Set the same URL on each enabled PTC, shortlink, offer, and task postback field:

```
https://coinixfaucet.mine.bz/api/offerwall/postback
```

The endpoint accepts Offerwall.me's documented POST fields and validates:
`md5(subId + transId + reward + secretKey)`.

A valid completion (status `1`) credits CNX, with the configured 20% bonus for eligible task types. A chargeback (status `2`) reverses the recorded credit up to the user's available CNX balance. Postbacks are idempotent by transaction ID and status. Successful postbacks reply with HTTP 200 and `ok`.

## Render environment variables

Add these in Render → coinix-faucet → Environment. Do not expose private values in frontend code or commit them:

- `OFFERWALL_APP_ID`: Offerwall.me public API key
- `OFFERWALL_SECRET_KEY`: Offerwall.me private placement Secret Key
- `OFFERWALL_API_TOKEN`: Offerwall.me Bearer Token

The private Secret Key is also used server-side to sign Offerwall.me user IDs. Signed identity expires after one hour. Current Offerwall.me integration rules require signed identities.

## Banner placements

The banner ID supplied in the account screenshot is embedded in the site for 728×90 and 300×250 sponsored slots:

`26tgnfk7s0fce1tscysrcpfeesr398`

The banner script is loaded from Offerwall.me and renders into the selected placement size.

## After deployment

1. Confirm the three Render variables contain the placement's actual credentials.
2. Confirm Offerwall.me placement currency is CNX / 6 decimals / 10000 units per USD.
3. Set all active PTC, shortlink, offer, and task postback fields to the URL above.
4. Test one PTC completion and one shortlink completion; verify one CNX credit per transaction.
5. Test a reversal/chargeback using Offerwall.me's test tools if available.
6. Ensure any external Cloudflare/WAF rules allow Offerwall.me's postback IP addresses:
   - `95.216.65.163`
   - `2a01:4f9:2b:1dc::2`

Older DOGE/PEPE/POL/FEYORRA/DGB wallet fields are retained and are not automatically converted into CNX. The new CNX balance is stored separately in `cnx_atomic`.

# CoinixFaucet — CNX and OfferwallAPI setup

## Currency settings in OfferwallAPI

Create/approve the website app with:

- Website URL: `https://coinixfaucet.mine.bz`
- Currency Name: `CNX`
- Currency Round: `6`
- Exchange Rate: `10000` (10,000 CNX per USD 1.00)
- Postback URL: `https://coinixfaucet.mine.bz/api/offerwallapi/postback`

The provider's `reward` field is already denominated in the configured publisher currency. Do not convert it a second time. CoinixFaucet credits that reward to the user's CNX balance and applies the existing 20% qualifying-task referral/bonus rules.

## Render environment variables

Set these in Render → coinix-faucet → Environment. Never commit or share the private values:

- `OFFERWALLAPI_API_KEY`: public app key (used by server when constructing the offerwall URL and feed endpoints)
- `OFFERWALLAPI_SECRET_KEY`: private postback signing secret
- `OFFERWALLAPI_BEARER_TOKEN`: private token for PTC, Video and Shortlink REST feeds
- `APP_URL`: `https://coinixfaucet.mine.bz`

Keep the existing `FAUCETPAY_API_KEY` secret configured with the SEND scope.

## Enabled integration

- Full Offerwall: `https://offerwallapi.com/offerwall/{API_KEY}/{TELEGRAM_USER_ID}`
- PTC feed: `/ptc-api/{API_KEY}/{USER_ID}/{USER_IP}`
- Video feed: `/video-api/{API_KEY}/{USER_ID}/{USER_IP}`
- Shortlink feed: `/sl-api/{API_KEY}/{USER_ID}/{USER_IP}`
- Server postback: `POST /api/offerwallapi/postback`

The user ID sent to OfferwallAPI is the exact Telegram user ID from the authenticated JWT. Do not trim, truncate, or otherwise transform it.

## Postback verification

CoinixFaucet accepts the provider's recommended HMAC-SHA256 signature:

`signature2 = HMAC-SHA256(subId + transId + reward, OFFERWALLAPI_SECRET_KEY)`

It also accepts the documented legacy MD5 signature:

`signature = MD5(subId + transId + reward + OFFERWALLAPI_SECRET_KEY)`

Postbacks are idempotent by `transId`. Status `1` credits CNX; status `2` processes a chargeback. Test callbacks with `debug=1` are acknowledged without crediting a real user.

If a WAF blocks the callback before it reaches Node, allow the documented headers:
- `User-Agent: OfferwallAPI-Postback/1.0`
- `Referer: https://offerwallapi.com/`

Do not add a static provider IP allowlist copied from an old integration. If IP filtering is enabled, use the current outbound IP shown in the OfferwallAPI publisher dashboard.

## CNX withdrawals

- Internal wallet: CNX, 6 decimal places.
- Fixed site valuation: 10,000 CNX = $1.00.
- Minimum withdrawal: 300 CNX ($0.03).
- Withdrawal flow: CNX → USD value → live DOGE/USD conversion → FaucetPay DOGE payout.
- Legacy coin balances are retained in Firestore and are not silently converted into CNX.

## Deployment checklist

1. Set the three OfferwallAPI credentials and FaucetPay SEND key in Render.
2. Set the OfferwallAPI app currency to CNX / 6 decimals / 10,000 units per USD.
3. Set the exact postback URL above in the OfferwallAPI app.
4. Confirm the app is approved and the domain is verified.
5. Deploy the `BursaliAlperen-patch-1` branch.
6. Send a provider test postback and confirm it returns HTTP 200 with `ok`; test postbacks do not credit balances.
7. Complete a real low-value task and confirm a single CNX credit in CoinixFaucet.
8. Test DOGE withdrawal only after FaucetPay balance and credentials are funded and verified.

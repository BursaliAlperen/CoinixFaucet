# Coinix Market — OfferwallAPI integration

Coinix Market is an OfferwallAPI-only inventory. It does not support user-created tasks or Telegram campaigns.

## Enabled inventory
- Micro Tasks via /task-api/{API_KEY}/{USER_ID}/{USER_IP}
- PTC via /ptc-api/{API_KEY}/{USER_ID}/{USER_IP}

No video, shortlink, survey, CPA offer, Telegram or self-created task categories are exposed in the Market UI.

## Credentials
Configure these deployment secrets:
- OFFERWALLAPI_KEY
- OFFERWALLAPI_BEARER_TOKEN
- OFFERWALLAPI_SECRET

Never expose them in frontend code or commit them to Git. Register the site in OfferwallAPI and set currency name to COINIX, an appropriate decimal precision, exchange rate and postback URL:
https://YOUR_DOMAIN/api/market/offerwallapi/postback

## Reward flow
- Micro Task proof is submitted server-to-server using the provider task ticket. The task remains pending until OfferwallAPI approves it and sends the S2S postback.
- PTC uses the provider-hosted URL returned by the PTC feed. Its timer and verification remain on OfferwallAPI.
- Only signed ptc and microtask postbacks are credited.
- status=1 credits; status=2 reverses the same reward as a chargeback.
- Exact subId matching and globally unique transId idempotency are enforced.
- Test callbacks with debug=1 are acknowledged but do not credit.

## API
- GET /api/market/feed — authenticated combined PTC + Micro Tasks feed.
- POST /api/market/microtasks/:taskId/submit — authenticated proof submission.
- POST /api/market/offerwallapi/postback — OfferwallAPI form-encoded S2S callback.

## Balance model
Rewards are credited to the separate users/{uid}.coinixAvailable internal ledger field. This is not a TON Jetton mint and does not prove a market price. Existing CNX faucet balances are not modified.

## Before launch
1. Add the three OfferwallAPI secrets to the hosting environment.
2. Set the exact public postback URL in OfferwallAPI.
3. Configure app currency as COINIX and deliberately select its reward exchange rate.
4. Run the OfferwallAPI Integration Test panel and verify a debug=1 test does not change balances.
5. Complete real PTC and Micro Task sandbox tests, including a chargeback and duplicate callback.
6. Review OfferwallAPI terms, supported GEOs and crypto reward policy before enabling live traffic.
7. Run security and staging tests before merging.

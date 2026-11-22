# Telegram advertising network shortlist

This list separates provider features from payment evidence. Test a provider with a small traffic cohort before enabling rewards.

## FlyerHubs — task / subscription API
- Docs: https://api.flyerhubs.com/redoc
- Bot API endpoints include get_me, get_tasks, check_task and check for mandatory subscriptions.
- Task completion statuses include incomplete, waiting and complete; Coinix credits only complete.
- Good match for task walls and mandatory Telegram subscriptions.
- Coinix integration is implemented behind FLYERHUBS_KEY.

## AdsGram — Reward, Interstitial and Task
- Publisher docs: https://docs.adsgram.ai/tr/publisher/
- Task integration: https://docs.adsgram.ai/publisher/task-integration-example
- Supports Telegram Mini App reward, interstitial and task formats.
- Official publisher docs state reward/interstitial are paid by CPM and tasks by CPC. Published withdrawal conditions: $10 minimum for a request made between the 1st and 5th; $100 minimum after the 5th; processing stated as 1–3 business days.
- Worth testing for Telegram task inventory. The SDK's browser callback should not be treated as a financial receipt unless the provider offers a verifiable server callback.

## Adsun — Reward, Interstitial, Task, bot messages and channel posts
- Docs: https://adsun.io/documentation
- SDK: https://adsun.io/sdk
- Covers Mini Apps, bots and channels. The publisher FAQ states USDT payouts and a $100 minimum withdrawal.
- Reward URL callbacks are documented; verify the exact callback signature, retry and event-id behavior before enabling Coinix rewards.

## LiteBits Ads — rewarded TMA SDK
- Docs: https://ads.litebits.io/docs/
- Telegram Mini App-only publisher SDK with server callback. It describes a signed server callback as the reward receipt and supports fallback demand from networks such as AdsGram, Monetag and others.
- Useful for mediation and server-confirmed rewards; confirm publisher eligibility and payout terms directly.

## Monetag — Rewarded Interstitial / Popup / In-App
- Docs: https://docs.monetag.com/
- Monetag's current TMA docs specify server postbacks with valued/non_valued and ymid. Coinix now includes a postback endpoint, but it must be configured in the publisher dashboard with the correct zone and secret.

## TADS — Mini App banners and rewarded
- Website: https://tads.me/
- The public site describes banner, fullscreen and rewarded Mini App inventory. Publisher payment thresholds and server callback details should be confirmed with the provider before integration.

## Recommendation
- Use FlyerHubs for task walls and mandatory subscription.
- Use Monetag for rewarded impressions because its official TMA docs define a server postback with valued status and ymid.
- Pilot AdsGram and Adsun as additional task/reward inventory after their publisher account, callback and payment details are independently verified.

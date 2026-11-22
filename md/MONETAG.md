# Monetag rewarded ads

Official TMA docs: https://docs.monetag.com/docs/postbacks/

The client creates a unique ymid for each ad show and passes it to the SDK:
`show_ZONE_ID({ ymid })`.

The browser Promise is only a UI signal. It does not grant rewards. The backend grants rewards only after Monetag calls the server postback with:
- event_type=impression
- reward_event_type=valued
- telegram_id matching the ymid prefix
- a valid MONETAG_POSTBACK_SECRET
- a unique ymid not previously credited

Configure the postback in Monetag SSP using this pattern (replace the host and macros with the exact placeholders shown in your Monetag panel):

`https://YOUR-COINIX-DOMAIN/postback/monetag?secret=YOUR_SECRET&ymid={ymid}&event_type={event_type}&reward_event_type={reward_event_type}&zone_id={zone_id}&sub_zone_id={sub_zone_id}&request_var={request_var}&telegram_id={telegram_id}&estimated_price={estimated_price}`

Set MONETAG_POSTBACK_SECRET in Render and configure the same secret in Monetag. Use the exact zone ID in Frontend settings (monetagZoneId). Daily ad limits are checked on the server. Default ad XP is 10; level 100 receives 2x the configured per-ad reward.

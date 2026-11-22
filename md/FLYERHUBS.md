# FlyerHubs integration

Official API documentation: https://api.flyerhubs.com/redoc

The backend uses the bot-side API host `https://api.flyerhubs.com` and JSON POST requests.

Implemented endpoints:
- POST /get_me — available to validate a bot key during setup; not called on every app request.
- POST /get_tasks — backend sends key, user_id, language_code and limit (10 max).
- POST /check_task — backend sends key and task signature; rewards are credited only when result is `complete`.

Set FLYERHUBS_KEY in Render. Never expose this key in Frontend JavaScript. For native Firebase channel tasks, add the Coinix bot as an administrator of each target channel/group so getChatMember can reliably verify membership. Unsupported task types are hidden until a real verifier is added.

Task reward is read from Firebase setting `flyerhubsTaskReward` (default 0.01 in app currency); XP is `flyerhubsTaskXp` (falls back to taskXp, default 20). Admins can change these values in the admin dashboard.

Provider task prices are denominated in RUB and are not automatically treated as Coinix reward values. The Coinix reward is a separate configurable value.

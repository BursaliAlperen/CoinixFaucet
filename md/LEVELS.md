# Coinix 100-level progression

- New users start at Level 1 with 0 XP.
- Daily check-in: 10 XP by default, once per reward day.
- Each verified new referral: 10 XP by default.
- Verified Monetag ad: 10 XP by default, only when a valued server postback is received.
- Completed standard task: 20 XP by default.
- Completed FlyerHubs task: 20 XP by default.
- XP thresholds rise each level using `50 + level*10 + level²*0.5`.
- Level is capped at 100.
- At Level 100, verified ad, standard task, FlyerHubs task and sponsor-task cash rewards are multiplied by 2.
- XP and cash multipliers are computed on the server; changing frontend values cannot bypass them.

Admins can adjust dailyCheckinXp, adWatchXp, taskXp, flyerhubsTaskXp, flyerhubsTaskReward, perAdEarning and dailyLimit in the admin dashboard.

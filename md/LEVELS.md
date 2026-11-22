# Coinix 100-level progression

- New users start at Level 1 with 0 XP.
- Daily check-in: 10 XP by default, once per reward day.
- Each verified new referral: 10 XP by default.
- Verified Monetag ad: 10 XP by default, only when a valued server postback is received.
- Completed standard task: 20 XP by default.
- Completed FlyerHubs task: 20 XP by default.
- XP thresholds rise each level using `50 + level*10 + level²*0.5`.
- Level is capped at 100.
- The reward multiplier is `1 + (level × 0.02)`: Level 1 = 1.02×, Level 50 = 2.00×, Level 100 = 3.00×.
- The server applies the multiplier to verified ad, standard task, FlyerHubs task and sponsor-task cash rewards. Client-side values are display-only.
- The multiplier is capped at 3.00× and cannot exceed Level 100.

Admins can adjust dailyCheckinXp, adWatchXp, taskXp, flyerhubsTaskXp, flyerhubsTaskReward, perAdEarning and dailyLimit in the admin dashboard.

---
layout: page
title: Achievements
---
## Achievements
ENiGMA½ includes a built-in achievement system that rewards users for activity on the board. Achievements are defined in `config/achievements.hjson` and fire automatically as users accumulate stats. When an achievement is earned the user sees a private interrupt notification; a separate global notification is broadcast to all other online users (if `globalText` is defined for that tier).

## Configuration

### Top-level keys

| Key | Description |
|-----|-------------|
| `enabled` | Set to `false` to disable the entire system. Default: `true` |
| `art` | Art file names for the four achievement interrupt frames (see [Art](#art) below) |
| `achievements` | Map of achievement tag → achievement definition |

### Achievement Definition

Each entry under `achievements` has a unique tag (e.g. `user_login_count`) and the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Trigger type — see [Achievement Types](#achievement-types) |
| `statName` | Yes | The user property stat name that drives this achievement |
| `retroactive` | No | If `true` (default), earning a higher tier also awards all lower unarned tiers in the same achievement. Set to `false` to only award the exact tier reached. |
| `match` | Yes | Map of numeric threshold → [match details](#match-details) |

### Match Details

Each key under `match` is a **numeric threshold**. When the triggering stat reaches or exceeds that value, the corresponding tier is awarded.

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Short title for the achievement tier |
| `text` | Yes | Private notification text shown only to the earning user. Supports [format variables](#format-variables). |
| `globalText` | No | Text broadcast to all other online users when this tier is earned. Omit to suppress global notifications. Supports [format variables](#format-variables). |
| `points` | Yes | Points awarded. Set to `0` for shame/novelty badges that carry no score. |

Example:
```hjson
user_login_count: {
    type: userStatSet
    statName: login_count
    match: {
        10: {
            title: "Curious Caller"
            globalText: "{userName} has logged into {boardName} {achievedValue} times!"
            text: "You've logged into {boardName} {achievedValue} times!"
            points: 10
        }
        25: {
            title: "Inquisitive"
            text: "You've logged into {boardName} {achievedValue} times!"
            points: 15
        }
    }
}
```

---

## Achievement Types

The `type` field controls when and how the stat value is compared against thresholds.

| Type | Fires on | Value compared |
|------|----------|----------------|
| `userStatSet` | Any `setUserStat` call | The new absolute value of the stat |
| `userStatInc` | Any `incrementUserStat` call | The **increment delta** for that single event (not the running total) |
| `userStatIncNewVal` | Any `incrementUserStat` call | The new cumulative total after the increment |

**When to use each:**

- `userStatSet` — Use when the stat is written as an absolute value (login count, streak days, account age in days, UL/DL ratio). The system compares the stored value against your thresholds.
- `userStatIncNewVal` — Use when the stat is incremented and you want to award based on lifetime totals (total messages posted, total mail sent, total files downloaded).
- `userStatInc` — Use when you want to award based on a single-event quantity (e.g. "downloaded 30 files in one session"). The threshold is compared against the per-event delta, not the running total. Set `retroactive: false` for these since they're per-event.

---

## Format Variables

The following variables may be used in `text`, `globalText`, and `title` fields via `{variableName}` syntax. ENiGMA½ [string format modifiers](../art/mci.md) (e.g. `{achievedValue!sizeWithAbbr}`) are supported.

| Variable | Description |
|----------|-------------|
| `{userName}` | Username of the user who earned the achievement |
| `{userRealName}` | User's real name |
| `{userLocation}` | User's location |
| `{userAffils}` | User's affiliations |
| `{nodeId}` | Node the user is on |
| `{title}` | Title of the earned tier |
| `{points}` | Points awarded for this tier |
| `{achievedValue}` | The threshold value that was met (e.g. `25` for the 25-login tier) |
| `{boardName}` | System board name from `general.boardName` in config |
| `{timestamp}` | ISO timestamp when the achievement was earned |

---

## Art

Four art files frame achievement interrupt displays. These are configured under the top-level `art` key and reference art files by name (resolved from the active theme, then system defaults):

| Key | Description |
|-----|-------------|
| `localHeader` | Header shown above the private (local) achievement notification |
| `localFooter` | Footer shown below the private notification |
| `globalHeader` | Header shown above the global broadcast notification |
| `globalFooter` | Footer shown below the global broadcast notification |

Art files support the same [format variables](#format-variables) as text fields, so you can display the achievement title, points, and user name directly in the art.

---

## Built-in Achievements

The default `config/achievements.hjson` ships with the following achievement categories. All can be customized, extended with additional tiers, or removed entirely.

| Achievement | Type | Stat | Tiers |
|-------------|------|------|-------|
| `user_login_count` | `userStatSet` | `login_count` | 2, 10, 25, 75, 100, 250, 500 logins |
| `user_login_streak` | `userStatSet` | `login_streak_days` | 7, 14, 30, 60, 100, 365 consecutive days |
| `user_post_count` | `userStatIncNewVal` | `post_count` | 2, 5, 20, 100, 250, 500 posts |
| `user_mail_sent_count` | `userStatIncNewVal` | `mail_sent_count` | 1, 10, 50, 200 messages |
| `user_node_msg_sent_count` | `userStatIncNewVal` | `node_msg_sent_count` | 1, 10, 50, 100 messages |
| `user_upload_count` | `userStatIncNewVal` | `ul_total_count` | 1, 10, 50, 100, 200 files |
| `user_upload_bytes` | `userStatSet` | `ul_total_bytes` | 10 KB → 23 GB |
| `user_download_count` | `userStatIncNewVal` | `dl_total_count` | 1, 10, 50, 100, 200 files |
| `user_download_bytes` | `userStatSet` | `dl_total_bytes` | 640 KB → 5 GB |
| `user_session_dl_count` | `userStatInc` | `dl_total_count` | 5, 15, 30, 45, 60, 90, 120 in one session |
| `user_session_ul_count` | `userStatInc` | `ul_total_count` | 5, 15, 30, 60 in one session |
| `user_ul_dl_ratio` | `userStatSet` | `ul_dl_ratio` | 0.25:1 → 10:1 ratio |
| `user_door_runs` | `userStatIncNewVal` | `door_run_total_count` | 1, 10, 50, 100, 200 runs |
| `user_individual_door_run_minutes` | `userStatInc` | `door_run_total_minutes` | 1, 5, 15, 30, 60, 120, 240 min single session |
| `user_door_run_total_minutes` | `userStatSet` | `door_run_total_minutes` | 10, 30, 60, 120, 240 min lifetime |
| `user_account_age` | `userStatSet` | `account_days_old` | 30 days, 1, 2, 5 years |
| `user_failed_login_count` | `userStatIncNewVal` | `failed_login_attempts` | 3, 10, 25, 50 failures (0 pts — shame badges) |
| `user_total_system_online_minutes` | `userStatSet` | `minutes_online_total_count` | 30 min → 1440 min lifetime |

### Login Streak Notes

The login streak system uses an **anti-cheat minimum gap** of 20 hours between logins before a new login counts toward the streak. This prevents the "midnight exploit" where logging in at 11:58 PM and again at 12:02 AM would count as two separate days despite only 4 minutes apart. A **48-hour grace window** means missing a day by a few hours doesn't break the streak — useful for users who log in at slightly different times each day.

### UL/DL Ratio Notes

The `ul_dl_ratio` stat is stored as an integer representing `(uploads / downloads) * 100`. A value of `100` means a 1:1 ratio; `200` means 2:1; `50` means 0.5:1. The ratio is only computed once the user has at least one upload and one download on record — new accounts are excluded to avoid divide-by-zero.

---

## ACS Integration

Two ACS codes check achievement progress:

| Code | Condition |
|------|-----------|
| `AC<n>` | User has earned >= _n_ total achievements |
| `AP<n>` | User has >= _n_ total achievement points |

See [ACS](acs.md) for general ACS documentation.

---

## MCI Codes

Two MCI codes expose achievement stats for use in art/menus:

| Code | Description |
|------|-------------|
| `%AC` | Current user's total achievement count |
| `%AP` | Current user's total achievement points |

See [MCI](../art/mci.md) for general MCI documentation.

---

## Leaderboards

Achievement totals can be surfaced in [Top-X](../modding/top-x.md) leaderboards using the User Event Log:

```hjson
mciMap: {
    1: {
        type: userEventLog
        value: achievement_pts_earned
        sum: true
        daysBack: 7   // omit for all-time
    }
    2: {
        type: userEventLog
        value: achievement_earned
        sum: false    // count individual achievements earned
        daysBack: 30
    }
}
```

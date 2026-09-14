# "Top Achievements" investigation — achievement total drift

Analysis performed 2026-09-14 against the live Xibalba databases. Question asked:
*Top Achievements never changes, yet plenty of users are earning achievements — is
the leaderboard broken?*

Answer: the leaderboard module is correct and reads live data. The **numbers it
ranks on are inflated** for 243 of 630 users, which distorts the ordering and
keeps three genuinely qualifying users off the list. Everyone else who is
currently earning achievements is legitimately far below the cutoff.

## How the list is built

`top_x` runs this on every draw — nothing is cached ([core/top_x.js](../core/top_x.js)):

```sql
SELECT user_id, CAST(prop_value AS INTEGER) AS value
FROM user_property
WHERE prop_name = 'achievement_total_points'   -- or achievement_total_count
ORDER BY value DESC
LIMIT <list view height>;
```

`TA` picks `mainMenuTopAchievementsStyle1` (12 rows) or `...Style2` (8 rows) at
random. Both rank on the running totals in `user_property`, not on
`user_achievement`.

Verified clean, so none of these are the cause:

- `user_property` has `UNIQUE(user_id, prop_name)` — no user can occupy two slots.
- All 1,260 achievement total rows are well-formed integers; zero `CAST` failures.
- Zero orphaned property rows; every one of the 630 users with achievements has
  both totals.
- Every account in the top 15 is `active`.

## The defect

Three sources should agree on what has been earned. They do not:

| Source | Awards | Points |
| --- | ---: | ---: |
| `user_achievement` (the award records) | 3,194 | 33,232 |
| `user_event_log` (`achievement_pts_earned`) | 3,258 | 32,162 |
| `user_property` — **what the leaderboard shows** | **4,454** | **44,887** |

The two independent records agree within ~3%. The leaderboard totals sit ~35%
above both: **1,260 phantom awards and 11,655 phantom points** spread over 243
users. Drift is *always* upward — no user's total is ever below what they earned.

(`user_event_log` is corroborating, not authoritative: `sys_event_user_log.js`
prunes entries older than `DefaultKeepForDays = 365` whenever a new one is
appended for the same user and log name.)

### Cause

Before [cd1936c9](https://github.com/NuSkooler/enigma-bbs/commit/cd1936c9)
(*Achievements bug fixes & mini revamp*, 2026-04-05), the retroactive tier walk
in `achievement.js` queued lower tiers unconditionally:

```js
this.loadAchievementHitCount(user, achievementTag, fld, (err, count) => {
    if (!err || (count && 0 === count)) {
        achievementsInfo.push(/* ... */);   // always taken on success
    }
    return nextKey(null);
});
```

On the success path `err` is null, so `!err` is true and the tier is queued
regardless of `count` — and the second clause is dead, since `count && 0 === count`
can never be true. `record()` then incremented both totals *before*
`INSERT OR IGNORE` silently dropped the duplicate row.

So every time a user crossed a new tier of a retroactive achievement, every lower
tier they already held was re-counted in their totals while the award table stayed
correct.

### Evidence this — and not data loss — is what happened

1. **Perfect cohort split.** The bug re-awards *lower tiers of the same
   achievement*, so partition users by the most tiers they hold of any single
   `achievement_tag` — not by how many different achievements they hold:

   ```sql
   WITH tiers AS (
       SELECT user_id, achievement_tag, COUNT(*) n
       FROM user_achievement GROUP BY user_id, achievement_tag
   ),
   grp AS (SELECT user_id, MAX(n) maxtier, SUM(n) real_count FROM tiers GROUP BY user_id),
   props AS (
       SELECT user_id, CAST(prop_value AS INTEGER) pc
       FROM user_property WHERE prop_name = 'achievement_total_count'
   )
   SELECT CASE WHEN g.maxtier = 1 THEN 'every achievement at exactly 1 tier'
               ELSE 'holds >=1 achievement at 2+ tiers' END AS cohort,
          COUNT(*) AS users,
          SUM(CASE WHEN p.pc <> g.real_count THEN 1 ELSE 0 END) AS with_drift
   FROM grp g JOIN props p USING(user_id) GROUP BY cohort;
   ```

   Users whose every achievement sits at exactly one tier: 315, **zero** drifted.
   Users holding at least one achievement at two or more tiers: 315, **243**
   drifted. A purge or deletion could not produce that split.
2. **Bounded by the mechanism.** The bug can generate at most `n(n-1)/2`
   duplicates per (user, achievement) with `n` tiers earned. 625 of 630 users sit
   strictly inside that bound; the 5 that exceed it (all 2019–2021 accounts)
   exceed it by 1–2.
3. **Clean cut at the fix.** Users whose first achievement postdates 2026-04-05:
   **0 of 56 drifted**. Users who predate it: 243 of 574.
4. Drift is exclusively upward, which is what a double-count produces and a
   deletion does not.

Current `achievement.js` checks `0 === info2.changes` and returns before touching
stats, so no new drift is accruing. The historical inflation stays in
`user_property` until it is recomputed.

## Impact on the list

Points column, top 12:

| Shown | Corrected |
| --- | --- |
| rmgr (680) | — drops out (really 395) |
| Crash_ (640) | — drops out (really 345), last earned 2022-02-24 |
| void (610) | — drops out (really 350), last earned 2022-11-22 |
| — | **paulie420** (490) enters at #5 |
| — | **apam** (430) enters at #11 |
| — | **cacobyte** (430) enters at #12 |

Count column: `Anachronist` and `Jim45` should be on it; `resmungo` and `cola`
should not.

`cacobyte` is the sharpest case — 230 points earned in September 2026, currently
shown at rank 14 and off both the 8- and 12-row lists purely because three
inflated totals sit above.

## Why the rest of the list is genuinely static

Correcting the totals does not make the list lively. It ranks *lifetime*
cumulative points, and the incumbents have stopped playing:

| Pos | User | Last achievement |
| ---: | --- | --- |
| 4 | mr_art | 2021-04-29 |
| 5 | resmungo | 2021-06-23 |
| 10 | Crash_ | 2022-02-24 |
| 12 | void | 2022-11-22 |

No one in the current top 12 has earned anything in 52 days. Meanwhile the
prolific recent earners are new users working through 5–25 point starter tiers —
AdmiralAcid (14 awards), Hologram Face (12), andy5995 (12), Knight Shadow (10),
helloCLD (9) — all 236–372 points short of the corrected cutoff of 430.

So the announcements are real and the list is right to omit them. If the goal is a
board that visibly moves, that is a **separate design change**: `top_x` already
supports a `userEventLog` source with a `daysBack` window, and
`sys_event_user_log.js` already records `achievement_earned` /
`achievement_pts_earned`, so a "Top Achievements — Last 90 Days" panel could be
added alongside the lifetime one without new plumbing.

## Repair

> :warning: **Stop the BBS first.** `StatLog.incrementUserStat()` reads the
> current total from the in-memory `User` object, not from the database:
>
> ```js
> const oldValue = user.getPropertyAsNumber(statName) || 0;
> const newValue = oldValue + incrementBy;
> ```
>
> A user who is online when the repair runs still holds their old inflated
> figure. The next achievement they earn persists `staleInflated + points`,
> undoing the repair for them. `_refreshUserStat()` only runs on display paths,
> never on the increment path, so nothing closes that window. The command
> prompts about this unless `--no-prompt` is given.

```
systemctl stop <your bbs service>

#  consistent single-file backup; a plain cp can miss outstanding WAL content
sqlite3 db/user.sqlite3 ".backup 'db/user.sqlite3.pre-achievfix.bak'"

./oputil.js user fix-achievement-stats --dry-run   # report only
./oputil.js user fix-achievement-stats             # write

systemctl start <your bbs service>
```

Recomputes both totals from `user_achievement` for any user whose stored totals
disagree, in a single transaction. Users who have never earned an achievement
carry no totals and are left untouched. Idempotent — a second run should report
nothing to do, and if it ever reports drift again, something is writing these
properties incorrectly.

Running it will visibly drop the headline numbers — djatropine 1654 → 1019,
NuSkooler 1430 → 930 — so it is worth deciding whether to announce it first.

It also fixes a second visible symptom: the `A` (Achievements) screen reads its
header totals from the inflated properties while listing rows from
`user_achievement`, so djatropine's header currently claims 93 achievements above
a list of 44.

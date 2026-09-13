---
title: Time Limits
description: "Daily per-user time budgets: allowance bands, ACS and MCI codes, and the per-account override."
sidebar:
    order: 16
---

ENiGMA½ can meter how long a user spends on the board each day and cut them off when their allowance runs out.

:::note
**Nothing is metered until you say so.** No allowance is configured out of the box, every user is unlimited, and upgrading an existing board changes nothing.
:::

Time used today is tracked regardless, so `TD` and `oputil.js user info` tell the truth on a board with no limits at all.

---

## Allowance

A user's daily allowance, in minutes, resolves in this order. The first tier that produces a value wins:

| Tier | Source |
|------|--------|
| Per-account override | `oputil.js user time USERNAME <minutes>` |
| Allowance band | The first `users.timeLimits` entry whose `acs` matches |
| Default band | A `users.timeLimits` entry with no `acs` at all |
| *(nothing matched)* | Unlimited |

`0` means unlimited in both the override and a band, consistently with `users.idleLogoutSeconds`.

### `users.timeLimits`

Bands are ordered and the first ACS match wins, exactly like [ACS-conditional art](../art/mci.md). An entry with no `acs` is the catch-all default, so put it last.

```hjson
users: {
    timeLimits: [
        {
            acs: GM[vip]
            minutesPerDay: 240
        }
        {
            acs: GM[users]
            minutesPerDay: 90
        }
        {
            //  no acs: the default for anyone unmatched above
            minutesPerDay: 30
        }
    ]

    //  what TR and TA render when no limit applies
    unlimitedTimeText: Unlimited
}
```

:::caution
Do not use [`ML`](acs.md) in a band's `acs`. It reads as "users with *n* minutes left get *n* minutes per day", which is circular; ENiGMA½ breaks the loop by treating the allowance as unlimited while a band is being evaluated, so such a band never does what it appears to say.
:::

### Per-account override

```
oputil.js user time USERNAME 120     # 120 minutes per day, whatever the bands say
oputil.js user time USERNAME 0       # unlimited
oputil.js user time USERNAME clear   # remove the override; the bands apply again
```

`oputil.js user info USERNAME` shows the override. It does not show which band would match, because a band is resolved against a live session's ACS.

---

## Who is never metered

The root user and every member of the `sysops` group are exempt, in code. This is not configurable, and it is not the same as ENiGMA½'s notion of "SysOp" elsewhere, which means the root account alone. Their time on is still tracked; nothing is enforced, and `TR` reads as unlimited.

---

## Art and ACS

| Code | |
|------|--|
| `TR` | Time remaining today, in minutes, or `unlimitedTimeText` |
| `TA` | Time allowed today, in minutes, or `unlimitedTimeText` |
| `TD` | Time used today, in minutes -- always a number |

`{TD} / {TA}` and `{TR} of {TA}` are the usual shapes. See [MCI Codes](../art/mci.md).

The [`ML`](acs.md) ACS code is true when the user has at least *n* minutes left:

```hjson
doorsMainMenu: {
    acs: ML15
}
```

`ML` is **true whenever no budget applies** -- no bands configured, an exempt user, or no session at all, which is the case when ACS is evaluated over NNTP or the web API. Unlimited time trivially satisfies "at least *n* minutes remaining", so `ML` cannot silently hide an area on a board that has not opted in.

---

## What is not metered

* **Per-call time.** The budget is per day; how it is spent across calls is the user's business.
* **Time banking, rollover and carry-over.** A day's allowance expires with the day.
* **Scheduled events.** A daily maintenance event does not shorten anyone's session.

The day rolls over lazily, when a user's time is next read or billed. A board that was offline at midnight still hands everyone a fresh balance on the next call.

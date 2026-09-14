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

A band is resolved **once per session**, and again if the session crosses midnight. ACS reads things that move while somebody is connected -- `MM` and `WD` most obviously, but also `GM` if you change a group -- and re-reading it mid-call would let an allowance fall underneath a caller who had already spent against the old one, dropping them to zero with no warning. The consequence is that editing `users.timeLimits` does not reach sessions already underway; the per-account override does, because you set that deliberately.

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

## Running out

A user is warned at **5, 3, 2 and 1** minutes remaining, each threshold once. The check rides the same one-minute tick that bills the minute -- the only moment the balance can change -- so a tick that skips from 6 straight to 2 still warns, once, at 2.

The text comes from `theme.timeWarningText`, which a theme may override through `customization.defaults.timeWarningText`, the same way `passwordChar` and the date formats work. `{minutes}` is the number remaining and `{plural}` is `s` unless that number is 1; [pipe codes](../art/colour-codes.md) are honoured. Setting it to an empty string turns the warnings off -- the kick at zero still happens.

```hjson
theme: {
    timeWarningText: "|12Time warning: |15{minutes} minute{plural}|12 remaining today.|00"
}
```

Warnings are queued the same way a node-to-node message is: they appear at the next point the user's current module can be interrupted, rather than landing in the middle of their art or their editor. Exempt and unlimited users are never warned.

A session that crosses midnight starts the new day with a fresh balance and a fresh set of warnings.

Time is billed a whole minute at a time, on a one-minute tick of its own. That tick is deliberately *not* the idle monitor's: several parts of the system stop the idle monitor for the duration of something that must not be interrupted -- MRC chat does it for a whole session -- and a daily allowance that stopped being billed for as long as someone stayed in chat would not be much of a limit.

At zero the user is sent to the `timeUpLogoff` menu and disconnected.

```hjson
timeUpLogoff: {
    art:    TIMEUP
    next:   @systemMethod:logoff
}
```

If the art does not exist -- which it does not until you draw it -- the user gets a plain message and is disconnected, rather than a blank screen. The same is true if you remove the menu.

A user whose allowance is already spent is refused at login rather than let in for a minute and then dropped.

:::note
Nothing *checks* the budget inside a door or a file transfer -- but the kick disconnects the session, and a running door dies with it. That is why doors are gated before they start; see below.
:::

---

## Doors

A door is refused *before* it starts rather than killed part way through, which is what PCBoard and Maximus do and what the drop file formats assume: the file states the budget and the door is expected to honour it.

```hjson
doorLord: {
    module: abracadabra
    config: {
        name: LORD
        minTimeLeftMinutes: 15
        notEnoughTimeArt: NOTIME
        ...
    }
}
```

With no `minTimeLeftMinutes` there is no check, and a user with no limit always passes. See [Scripts & Binaries](../doors/scripts-and-binaries.md).

---

## File transfers

**Uploads are free.** They cost the caller nothing from their daily budget, as they do in every package that has an opinion on it -- Synchronet inverts its own flag name so that free is the default.

**Downloads are charged, and checked before they start.** A download that cannot finish in the time the caller has left is refused up front rather than being severed mid-flight by the kick, which would cost them the minutes and leave a partial file. They are told how long it needs and how long they have.

Nothing in ENiGMA½ measures the real transfer rate, so the check works from an assumption:

```hjson
fileBase: {
    //  bytes/sec; 0 disables the check entirely
    estimatedTransferCps: 14400
}
```

The default is deliberately optimistic: over-stating the rate under-states the time, so a marginal download is allowed rather than refused. Lower it if your callers are on slow links and you would rather they were told up front. The check never applies to a user with no limit, it judges the whole batch rather than file by file, and a queue whose size cannot be determined always goes through.

---

## What is not metered

* **Per-call time.** The budget is per day; how it is spent across calls is the user's business.
* **Time banking, rollover and carry-over.** A day's allowance expires with the day.
* **Scheduled events.** A daily maintenance event does not shorten anyone's session.

The day rolls over lazily, when a user's time is next read or billed. A board that was offline at midnight still hands everyone a fresh balance on the next call.

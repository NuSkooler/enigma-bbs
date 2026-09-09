---
layout: page
title: Access Condition System (ACS)
---

## Access Condition System (ACS)

ENiGMA½ uses an Access Condition System (ACS) that is both familiar to oldschool BBS operators and has its own style. With ACS, SysOps are able to control access to various areas of the system based on conditions such as group membership, connection type, terminal capabilities, and more. Various touch points in the system are configured to allow for `acs` checks. In some cases ACS is a simple boolean check while others (via ACS blocks) allow defining what conditions must be true for certain _rights_ such as `read` and `write` (though others exist as well).

---

## Group Membership

ENiGMA½ does not utilize legacy "security levels" (see note below) but instead uses a group system. Users may belong to one or more groups which can be checked by the `GM` ACS code (see [ACS Codes](#acs-codes) below). Two special groups exist out of the box:

1. `users`: Any regular user.
2. `sysops`: System Operators. The first user (your root/admin) will always belong to this group.

You do not need to explicitly create groups: by checking for them via ACS and adding members to a group, they implicitly exist within the system. You may use as many groups as you like. See [`oputil user group`](../admin/oputil.md#user) for adding and removing users to groups.

> :information_source: Many drop file formats require a security level. As such, the following apply: root user or users in `sysops` group receive a security level of `100` while standard `users` receive `30`.

---

## ACS Grammar

ACS strings are one or more ACS codes combined with logical operators. Whitespace (spaces) between operators, codes, and parentheses is optional — you can write compact strings like `GM[users]|NC5` or readable ones like `GM[users] | NC5`.

### Operators

| Operator | Name | Description |
|:--------:|------|-------------|
| `&` | AND | Both sides must be true. **This is also the default** — two adjacent codes with no operator are implicitly AND'd. |
| `\|` | OR | Either side must be true. |
| `!` | NOT | Negates the following check. |
| `(` `)` | Grouping | Control evaluation order. |

### Operator Precedence

From highest to lowest:

1. `!` (NOT) — binds tightest, applies to the immediately following code or group
2. Implicit AND / `&` — adjacent codes or explicit `&`
3. `|` (OR) — loosest binding

Parentheses override precedence: `(A | B) & C` requires either A or B to be true, AND C to be true.

### Arguments

ACS codes take an optional argument immediately after the two-letter code:

| Form | Description | Examples |
|------|-------------|---------|
| *number* | A single integer value | `NC5`, `TH24`, `AA30` |
| `[`*values*`]` | A comma-separated list of values in brackets | `GM[users,sysops]`, `ID[1,42]`, `WD[0,6]` |
| *(none)* | Some codes take no argument | `SC`, `LC` |

Spaces are allowed around commas inside lists: `GM[users, sysops]` is valid.

### Examples

| ACS String | Meaning |
|------------|---------|
| `GM[users]` | User belongs to the `users` group |
| `NC2` | User has called at least 2 times |
| `ID1` | User is ID 1 (the SysOp) |
| `GM[elite,power]` | User belongs to `elite` or `power` group |
| `ID1 \| GM[co-op]` | User is the SysOp OR belongs to `co-op` |
| `!TH24` | Terminal height is NOT exactly 24 (i.e., 24 fails; 25+ passes since `TH` checks `>=`) |
| `GM[users] & SC` | User is in `users` group AND connection is secure |
| `GM[users] NC5` | Same as above but with implicit AND — user is in group AND has 5+ calls |
| `(GM[sysops] \| ID1) & SC` | SysOp or ID 1, AND secure connection required |
| `!GM[banned]` | User is NOT in the `banned` group |
| `GM[users] & !GM[restricted]` | In `users` but not in `restricted` |

---

## ACS Codes

The following ACS codes are available:

### User & Authentication

| Code | Condition |
|------|-----------|
| `ID`*n*, `ID[`*n,...*`]` | User's ID is *n* or one of [*n,...*] |
| `GM[`*group,...*`]` | User belongs to one of [*group,...*] |
| `AG`*age* | User's age is >= *age* years |
| `AS`*status*, `AS[`*status,...*`]` | User's account status is *status* or one of [*status,...*]. `0`=inactive, `1`=active. |
| `AF`*factor* | User's current authentication factor is >= *factor*. Factor 1 = password/pubkey, factor 2 = 2FA (OTP). |
| `AR`*factor* | User **requires** authentication factor >= *factor*. `1`=always true, `2`=true only if user has 2FA configured. |
| `PV[`*name*`,`*value*`]` | User property *name* is exactly *value*. Allows arbitrary property checks, e.g. `PV[message_conf,local]`. |

### Activity & Statistics

| Code | Condition |
|------|-----------|
| `NC`*calls* | User's login/call count is >= *calls* |
| `NP`*posts* | User's message post count is >= *posts* |
| `AA`*days* | User's account is >= *days* old |
| `UP`*count* | User's upload file count is >= *count* |
| `DL`*count* | User's download file count is >= *count* |
| `BU`*bytes* | User's total uploaded bytes is >= *bytes* |
| `BD`*bytes* | User's total downloaded bytes is >= *bytes* |
| `NR`*ratio* | User's upload/download count ratio is >= *ratio*% |
| `KR`*ratio* | User's upload/download byte ratio is >= *ratio*% |
| `PC`*ratio* | User's post/call ratio is >= *ratio*% |

### Achievements

| Code | Condition |
|------|-----------|
| `AC`*count* | User's total achievement count is >= *count* |
| `AP`*points* | User's total achievement points is >= *points* |

### Connection & Terminal

| Code | Condition |
|------|-----------|
| `LC` | Connection is local |
| `SC` | Connection is secure (SSL/TLS, secure WebSocket, etc.) |
| `EC`*encoding* | Terminal encoding: `0` = CP437, `1` = UTF-8 |
| `TH`*height* | Terminal height is >= *height* |
| `TW`*width* | Terminal width is >= *width* |
| `TT[`*type,...*`]` | Terminal type is one of [*type,...*] (`ansi`, `xterm`, etc.) |
| `TM[`*theme,...*`]` | User's current theme ID is one of [*theme,...*] (e.g. `luciano_blocktronics`) |
| `NN`*node*, `NN[`*node,...*`]` | Current node number is *node* or one of [*node,...*] |

### Time & Date

| Code | Condition |
|------|-----------|
| `WD`*day*, `WD[`*day,...*`]` | Day of week is *day* or one of [*day,...*]. `0`=Sunday, `1`=Monday, ..., `6`=Saturday. |
| `MM`*minutes* | Current time is >= *minutes* past midnight (system time) |

### Services & Features

| Code | Condition |
|------|-----------|
| `SE[`*service,...*`]` | All listed services are enabled. Service names are **case-insensitive**. Available: `http`, `https`, `web` (either http or https), `gopher`, `nntp`, `nntps`, `activitypub` (requires web), `nodeinfo2` (requires web), `webfinger` (requires web). Unknown service names always fail. |
| `AE`*enabled* | ActivityPub is enabled for the current user: `1`=yes, `0`=no |

---

## ACS Blocks

Some areas of the system require more than a single ACS string. In these situations an *ACS block* is used to allow finer-grained control. Each key in the block names a right (`read`, `write`, `download`, etc.) and maps to an ACS string.

```hjson
acs: {
    read: GM[users]
    write: GM[sysops,co-ops]
    download: GM[elite] | UP10
}
```

All `users` can read (see) the area, `sysops` and `co-ops` can write (upload), and only members of `elite` or those with 10+ uploads can download.

### Defaults

When an ACS block is not specified (or a particular scope is missing), the system applies sensible defaults:

| Context | Scope | Default |
|---------|-------|---------|
| Message Conference | `read` | `GM[users]` |
| Message Conference | `write` | `GM[users]` |
| Message Area | `read` | `GM[users]` |
| Message Area | `write` | `GM[users]` |
| File Area | `read` | `GM[users]` |
| File Area | `write` | `GM[sysops]` |
| File Area | `download` | `GM[users]` |
| FSE Body Upload | `uploadAcs` | `GM[users]` |
| Menu Module | `acs` | *(no check — all users can access)* |

> :information_source: The FSE (Full Screen Editor) uses a scope called `uploadAcs` (not `upload`) for controlling who can upload a file into a message body. This is distinct from the file area `write` scope which controls file base uploads. The `uploadAcs` scope is checked on the FSE's menu config to decide whether the "Upload" option appears in the editor menu. If you want to restrict message body file uploads, set `uploadAcs` in your FSE menu entry's config block:
>
> ```hjson
> config: {
>     uploadAcs: GM[sysops]  // only sysops can upload files into messages
> }
> ```

---

## ACS Touch Points

The following areas of the system support ACS checks:

* [Message conferences and areas](../messageareas/configuring-a-message-area.md)
* [File base areas](../filebase/first-file-area.md) and [Uploads](../filebase/uploads.md)
* Menus within [Menu HJSON (menu.hjson)](menu-hjson.md) — use `acs` in a menu's `config` block to restrict access
* Conditional `next` / `action` arrays in menu configuration — each entry can include an `acs` field to control which branch is taken

See the specific area documentation for details on available scopes and defaults.

---

## Conditional Values

Some configuration fields (such as `next` in menus) support conditional arrays where each element may include an `acs` check. The first matching condition is used:

```hjson
next: [
    {
        acs: GM[sysops]
        next: sysopMainMenu
    }
    {
        acs: GM[users]
        next: userMainMenu
    }
    {
        // No acs — fallback for everyone else
        next: guestMenu
    }
]
```

---

## See Also

* [File Base ACS](../filebase/acs.md)
* [Configuring Message Areas](../messageareas/configuring-a-message-area.md)
* [Menu HJSON](menu-hjson.md)

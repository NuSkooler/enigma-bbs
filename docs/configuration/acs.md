---
layout: page
title: Access Condition System (ACS)
---

## Access Condition System (ACS)
ENiGMA½ uses an Access Condition System (ACS) that is both familure to oldschool BBS operators and has it's own style. With ACS, SysOp's are able to control access to various areas of the system based on various conditions such as group membership, connection type, etc. Various touch points in the system are configured to allow for `acs` checks. In some cases ACS is a simple boolean check while others (via ACS blocks) allow to define what conditions must be true for certain _rights_ such as `read` and `write` (though others exist as well).

## ACS Codes
The following are ACS codes available as of this writing:

| Code | Condition |
|------|-------------|
| LC | Connection is local |
| AG<i>age</i> | User's age is >= _age_ |
| AS<i>status</i>, AS[_status_,...] | User's account status is _group_ or one of [_group_,...] |
| EC<i>encoding</i> | Terminal encoding is set to _encoding_ where `0` is `CP437` and `1` is `UTF-8` |
| GM[_group_,...] | User belongs to one of [_group_,...] |
| NN<i>node</i> | Current node is _node_ |
| NP<i>posts</i> | User's number of message posts is >= _posts_ |
| NC<i>calls</i> | User's number of calls is >= _calls_ |
| SC | Connection is considered secure (SSL, secure WebSockets, etc.) |
| TH<i>height</i> | Terminal height is >= _height_ |
| TW<i>width</i> | Terminal width is >= _width_ |
| TM[_themeId_,...] | User's current theme ID is one of [_themeId_,...] (e.g. `luciano_blocktronics`) |
| TT[_termType_,...] | User's current terminal type is one of [_termType_,...] (`ANSI-BBS`, `utf8`, `xterm`, etc.) |
| ID<i>id</i>, ID[_id_,...] | User's ID is _id_ or oen of [_id_,...] |
| WD<i>weekDay</i>, WD[_weekDay_,...] | Current day of week is _weekDay_ or one of [_weekDay_,...] where `0` is Sunday, `1` is Monday, and so on. |

\* Many more ACS codes are planned for the near future.

## ACS Strings
ACS strings are one or more ACS codes in addition to some basic language semantics. 

The following logical operators are supported:
* `!` NOT
* `|` OR
* `&` AND (this is the default)

ENiGMA½ also supports groupings using `(` and `)`. Lastly, some ACS codes allow for lists of acceptable values using `[` and `]` — for example, `GM[users,sysops]`.

### Examples
* `NC2`: User must have called two more more times for the check to return true (to pass)
* `ID1`: User must be ID 1 (the +op)
* `GM[elite,power]`: User must be a member of the `elite` or `power` user group (they could be both)
* `ID1|GM[co-op]`: User must be ID 1 (SysOp!) or belong to the `co-op` group
* `!TH24`: Terminal height must NOT be 24


## ACS Touch Points
The following touch points exist in the system. Many more are planned:

* Message conferences and areas
* File base areas
* Menus within `menu.hjson`

See the specific areas documentation for information on available ACS checks.

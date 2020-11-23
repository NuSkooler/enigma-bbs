---
layout: page
title: TopX
---
## The TopX Module
The built in `top_x` module allows for displaying oLDSKOOL (?!) top user stats for the week, month, etc. Ops can configure what stat(s) are displayed and how far back in days the stats are considered.

## Configuration
### Config Block
Available `config` block entries:
* `mciMap`: Supplies a mapping of MCI code to data source. See `mciMap` below.

#### MCI Map (mciMap)
The `mciMap` `config` block configures MCI code mapping to data sources. Currently the following data sources (determined by `type`) are available:

| Type | Description |
|-------------|-------------|
| `userEventLog` | Top counts or sum of values found in the User Event Log. |
| `userProp` | Top values (aka "scores") from user properties. |

##### User Event Log (userEventLog)
When `type` is set to `userEventLog`, entries from the User Event Log can be counted (ie: individual instances of a particular log item) or summed in the case of log items that have numeric values. The default is to sum.

Some current User Event Log `value` examples include `ul_files`, `dl_file_bytes`, or `achievement_earned`. See [user_log_name.js](/core/user_log_name.js) for additional information.

Example `userEventLog` entry:
```hjson
mciMap: {
    1: { //  e.g.: %VM1
        type: userEventLog
        value: achievement_pts_earned // top achievement points earned
        sum: true // this is the default
        daysBack: 7 // omit daysBack for all-of-time
    }
}
```

#### User Properties (userProp)
When `type` is set to `userProp`, data is collected from individual user's properties. For example a `value` of `minutes_online_total_count`. See [user_property.js](/core/user_property.js) for more information.

Example `userProp` entry:
```hjson
mciMap: {
    2: { // e.g.: %VM2
        type: userProp
        value: minutes_online_total_count // top users by minutes spent on the board
    }
}
```

## Theming
Generally `mciMap` entries will point to a Vertical List View Menu (`%VM1`, `%VM2`, etc.). The following `itemFormat` object is provided:
* `value`: The value acquired from the supplied data source.
* `userName`: User's username.
* `realName`: User's real name.
* `location`: User's location.
* `affils` or `affiliation`: Users affiliations.
* `position`: Rank position (numeric).

Remember that string format rules apply, so for example, if displaying top uploaded bytes (`ul_file_bytes`), a `itemFormat` may be `{userName} - {value!sizeWithAbbr}` yielding something like "TopDude - 4 GB". See [MCI](../art/mci.md) for additional information.

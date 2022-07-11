---
layout: page
title: Last Callers
---
## The Last Callers Module
The built in `last_callers` module provides flexible retro last callers mod.

## Configuration
### Config Block
Available `config` block entries:
* `dateTimeFormat`: [moment.js](https://momentjs.com) style format. Defaults to current theme → system `short` format.
* `user`: User options:
    * `collapse`: Collapse or roll up entries that fall within the period specified. May be a string in the form of `30 minutes`, `3 weeks`, `1 hour`, etc.
* `sysop`: Sysop options:
    * `collapse`: Collapse or roll up entries that fall within the period specified. May be a string in the form of `30 minutes`, `3 weeks`, `1 hour`, etc.
    * `hide`: Boolean: Hide all +op logins.
* `actionIndicators`: Maps user events/actions to indicators. For example: `userDownload` to "D". Available indicators:
    * `newUser`: User is new.
    * `dlFiles`: User downloaded file(s).
    * `ulFiles`: User uploaded file(s).
    * `postMsg`: User posted message(s) to the message base, EchoMail, etc.
    * `sendMail`: User sent _private_ mail.
    * `runDoor`: User ran door(s).
    * `sendNodeMsg`: User sent a node message(s).
    * `achievementEarned`: User earned an achievement(s).
* `actionIndicatorDefault`: Default indicator when an action is not set. Defaults to "-".

Remember that entries such as `actionIndicators` and `actionIndicatorDefault` may contain pipe color codes!

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `userId`: User ID.
* `userName`: Login username.
* `realName`: User's real name.
* `ts`: Timestamp in `dateTimeFormat` format.
* `location`: User's location.
* `affiliation` or `affils`: Users affiliations.
* `actions`: A string built by concatenating action indicators for a users logged in session. For example, given a indicator of `userDownload` mapped to "D", the string may be "-D----". The format was made popular on Amiga style boards.



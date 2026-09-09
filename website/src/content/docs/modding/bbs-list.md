---
layout: page
title: BBS List
---
## The BBS List Module
The built in `bbs_list` module provides the ability for users to manage entries to other Bulletin Board Systems.

## Configuration
### Config Block
Available `config` block entries:
* `youSubmittedFormat`: Provides a format for entries that were submitted (and therefor ediable) by the current user. Defaults to `'{submitter} (You!)'`. Utilizes the same `itemFormat` object as entries described below.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`) (the BBS list):
* `id`: Row ID
* `bbsName`: System name. Note that `{text}` also contains this value.
* `sysOp`: System Operator
* `telnet`: Telnet address
* `www`: Web address
* `location`: System location
* `software`: System's software
* `submitter`: Username of entry submitter
* `submitterUserId`: User ID of submitter
* `notes`: Any additional notes about the system

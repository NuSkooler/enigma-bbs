---
layout: page
title: User List
---
## The User List Module
The built in `user_list` module provides basic user list functionality.

## Configuration
### Config Block
Available `config` block entries:
* `dateTimeFormat`: [moment.js](https://momentjs.com) style format. Defaults to current theme → system `short` format.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `userId`: User ID.
* `userName`: Login username.
* `realName`: User's real name.
* `lastLoginTimestamp`: Full last login timestamp for formatting use.
* `lastLoginTs`: Last login timestamp formatted with `dateTimeFormat` style.
* `location`: User's location.
* `affiliation` or `affils`: Users affiliations.

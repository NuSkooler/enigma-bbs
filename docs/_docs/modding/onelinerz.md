---
layout: page
title: Onelinerz
---
## The Onelinerz Module
The built in `onelinerz` module provides a retro onelinerz system.

## Configuration
### Config Block
Available `config` block entries:
* `dateTimeFormat`: [moment.js](https://momentjs.com) style format. Defaults to current theme → system `short` date format.
* `dbSuffix`: Provide a suffix that will be appended to the DB name to use onelinerz for more than one purpose (separate lists).

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `userId`: User ID of the onliner entry.
* `userName`: Login username of the onliner entry.
* `oneliner`: The oneliner text. Note that the standard `{text}` field also contains this value.
* `ts`: Timestamp of the entry formatted with `dateTimeFormat` format described above.

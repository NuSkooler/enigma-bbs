---
layout: page
title: Message Area List
---
## The Message Area List Module
The built in `msg_area_list` module provides a menu to display and change between message areas in the users current conference.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `index`: 1-based index into list.
* `areaTag`: Area tag.
* `name` or `text`: Display name.
* `desc`: Description.

The following additional MCIs are updated as the user changes selections in the main list:
* MCI 2 (ie: `%TL2` or `%M%2`) is updated with the area description.
* MCI 10+ (ie `%TL10`...) are custom ranges updated with the same information available above in `itemFormat`. Use `areaListItemFormat##`.

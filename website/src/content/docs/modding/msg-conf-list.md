---
layout: page
title: Message Conference List
---
## The Message Conference List Module
The built in `msg_conf_list` module provides a menu to display and change between message conferences.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `index`: 1-based index into list.
* `confTag`: Conference tag.
* `name` or `text`: Display name.
* `desc`: Description.
* `areaCount`: Number of areas in this conference.

The following additional MCIs are updated as the user changes selections in the main list:
* MCI 2 (ie: `%TL2` or `%M%2`) is updated with the conference description.
* MCI 10+ (ie `%TL10`...) are custom ranges updated with the same information available above in `itemFormat`.

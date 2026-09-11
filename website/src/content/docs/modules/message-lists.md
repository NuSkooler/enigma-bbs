---
title: Message Conference & Area Lists
description: "The two menus users navigate the message base with — conference list and area list."
sidebar:
    order: 10
---
Two modules let users move around the [message base](../messageareas/configuring-a-message-area.md).
They work the same way and are themed the same way; which one you are looking at
depends on whether the user is picking a conference or an area within it.

| Module | Menu | Lists |
|--------|------|-------|
| `msg_conf_list` | Message conference list | Every conference the user can [see](../configuration/acs.md) |
| `msg_area_list` | Message area list | Areas within the user's current conference |

## Theming

Both provide an `itemFormat` object to MCI 1 (`%VM1`):

| Field | Available on | Description |
|-------|--------------|-------------|
| `index` | both | 1-based index into the list |
| `name` or `text` | both | Display name |
| `desc` | both | Description |
| `confTag` | conference list | Conference tag |
| `areaTag` | area list | Area tag |
| `areaCount` | conference list | Number of areas in the conference |

Both also update additional MCIs as the user moves through the list:

* MCI 2 (`%TL2`) receives the description of the selected entry.
* MCI 10+ (`%TL10` and up) are custom ranges carrying the same fields as
  `itemFormat` above. The area list formats these with `areaListItemFormat##`.

See **Entry Formatting** in [MCI Codes](../art/mci.md) for the format syntax, and
[Themes](../art/themes.md#custom-range-info-formatting) for where custom range
formats are declared.

## See Also

* [Configuring a Message Area](../messageareas/configuring-a-message-area.md) — conferences, areas and their ACS
* [Configure Newscan](configure-newscan.md) — which of these areas a user's newscan covers

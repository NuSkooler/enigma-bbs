---
title: Message Lists
description: "Conference, area and message lists, including first unread navigation."
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

## Message List Navigation

The `msg_list` module displays messages within an area, personal messages and
search results. The shipped menus provide these shortcuts:

| Key | Action |
|-----|--------|
| `U` | Jump to the first unread message |
| Home | Move toward the top, stopping at the first unread message if it is above the selected row |
| End | Move toward the bottom, stopping at the first unread message if it is below the selected row |

Press Home or End again from the first unread message to reach the respective
end. With no unread messages, `U` leaves the selection alone and Home/End go
straight to the ends. The selected-message labels update with the selection.

Unread status uses the list's read state when it was loaded, including explicit
`isNew` flags supplied by personal or search lists. Opening a message or starting
a post can change the return-focus position without changing the unread target.
Marking an area read within the list also clears its unread targets.

### Configuring the Shortcuts

Add entries to the existing `actionKeys` array in form `0` of
`messageBaseMessageList`, `messageBaseMyMessagesList` and
`messageBaseSearchResultsMessageList`:

```hjson
{ keys: [ "u", "shift + u" ], action: @method:jumpToFirstUnread }
{ keys: [ "home" ], action: @method:messageListHome }
{ keys: [ "end" ], action: @method:messageListEnd }
```

Keep the existing quit, post and other bindings. If the form uses
`actionKeys: @reference:common.quitToPrev`, replace that value with an array
beginning with `@reference:common.quitToPrevEntry` and add the entries above.
You can choose another key for any action, or omit the Home/End bindings to keep
those keys going straight to the ends. Existing `menu.hjson` files are not updated
automatically; see [Upgrade Notes](../admin/upgrade-notes.md).

## See Also

* [Configuring a Message Area](../messageareas/configuring-a-message-area.md) — conferences, areas and their ACS
* [Configure Newscan](configure-newscan.md) — which of these areas a user's newscan covers

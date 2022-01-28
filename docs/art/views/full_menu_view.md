---
layout: page
title: Full Menu View
---
## Full Menu View
A full menu view supports displaying a list of times on a screen in a very configurable manner. A full menu view supports either a single row or column of values, similar to Horizontal Menu (HM) and Vertical Menu (VM), or in multiple columns.

## General Information

Items can be selected on a menu via the cursor keys, Page Up, Page Down, Home, and End, or by selecting them via a `hotKey` - see ***Hot Keys*** below.

:information_source: A full menu view is defined with a percent (%) and the characters FM, followed by the view number. For example: `%FM1`

:information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets focus text style. See **Text Styles** in [MCI](../mci.md)|
| `itemSpacing` | Used to separate items vertically in the menu |
| `itemHorizSpacing` | Used to separate items horizontally in the menu |
| `height` | Sets the height of views to display multiple items vertically (default 1) |
| `width` | Sets the width of a view to display one or more columns horizontally (default 15)|
| `focus` | If set to `true`, establishes initial focus |
| `submit` | If set to `true` any `accept` action upon this view will submit the encompassing **form** |
| `hotKeys` | Sets hot keys to activate specific items. See **Hot Keys** below |
| `hotKeySubmit` | Set to submit a form on hotkey selection |
| `argName` | Sets the argument name for this selection in the form |
| `justify` | Sets the justification of each item in the list. Options: left (default), right, center |
| `itemFormat` | Sets the format for a list entry. See **Entry Formatting** in [MCI](../mci.md) |
| `fillChar` | Specifies a character to fill extra space in the menu with. Defaults to an empty space |
| `textOverflow` | If a single column cannot be displayed due to `width`, set overflow characters. See **Text Overflow** below |
| `items` | List of items to show in the menu. See **Items** below.
| `focusItemFormat` | Sets the format for a focused list entry. See **Entry Formatting** in [MCI](../mci.md) |


### Hot Keys

A set of `hotKeys` are used to allow the user to press a character on the keyboard to select that item, and optionally submit the form.

Example:

```
hotKeys: { A: 0, B: 1, C: 2, D: 3 }
hotKeySubmit: true
```
This would select and submit the first item if `A` is typed, second if `B`, etc.

### Items

A full menu, similar to other menus, take a list of items to display in the menu. For example:


```
items: [
  {
      text: First Item
      data: first
  }
  {
      text: Second Item
      data: second
  }
]
```

If the list is for display only (there is no form action associated with it) you can omit the data element, and include the items as a simple list:

```
["First item", "Second item", "Third Item"]
```

### Text Overflow

The `textOverflow` option is used to specify what happens when a text string is too long to fit in the `width` defined. Note, because columns are automatically calculated, this can only occur when the text is too long to fit the `width` using a single column.

:information_source: If `textOverflow` is not specified at all, a menu can become wider than the `width` if needed to display a single column.

:information_source: Setting `textOverflow` to an empty string `textOverflow: ""` will cause the item to be truncated if necessary without any characters displayed

:information_source: Otherwise, setting `textOverflow` to one or more characters will truncate the value if necessary and display those characters at the end. i.e. `textOverflow: ...`

## Examples

### A simple vertical menu - similar to VM

![Example](../../assets/images/full_menu_view_example1.gif "Vertical menu")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
FM1: {
  submit: true
  argName: navSelect
  width: 1
  items: [
    {
      text: login
      data: login
    }
    {
      text: apply
      data: new user
    }
    {
      text: about
      data: about
    }
    {
      text: log off
      data: logoff
    }
  ]
}

```
</div>
</details>

### A simple horizontal menu - similar to HM

![Example](../../assets/images/full_menu_view_example2.gif "Horizontal menu")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
FM2: {
  focus: true
  height: 1
  width: 60 // set as desired
  submit: true
  argName: navSelect
  items: [
    "prev", "next", "details", "toggle queue", "rate", "help", "quit"
  ]
}
```
</div>
</details>

### A multi-column navigation menu with hotkeys


![Example](../../assets/images/full_menu_view_example3.gif "Multi column menu")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
FM1: {
  focus: true
  height: 6
  width: 60
  submit: true
  argName: navSelect
  hotKeys: { M: 0, E: 1, D: 2 ,F: 3,!: 4, A: 5, C: 6, Y: 7, S: 8, R: 9, O: 10, L:11, U:12, W: 13, B:14, G:15, T: 16, Q:17  }
  hotKeySubmit: true
  items: [
    {
      text: M) message area
      data: message
    }
    {
      text: E) private email
      data: email
    }
    {
      text: D) doors
      data: doors
    }
    {
      text: F) file base
      data: files
    }
    {
      text: !) global newscan
      data: newscan
    }
    {
      text: A) achievements
      data: achievements
    }
    {
      text: C) configuration
      data: config
    }
    {
      text: Y) user stats
      data: userstats
    }
    {
      text: S) system stats
      data: systemstats
    }
    {
      text: R) rumorz
      data: rumorz
    }
    {
      text: O) onelinerz
      data: onelinerz
    }
    {
      text: L) last callers
      data: callers
    }
    {
      text: U) user list
      data: userlist
    }
    {
      text: W) whos online
      data: who
    }
    {
      text: B) bbs list
      data: bbslist
    }
    {
      text: G) node-to-node messages
      data: nodemessages
    }
    {
      text: T) multi relay chat
      data: mrc
    }
    {
      text: Q) quit
      data: quit
    }
  ]
}
```
</div>
</details>


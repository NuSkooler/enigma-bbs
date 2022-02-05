---
layout: page
title: Toggle Menu View
---
## Toggle Menu View
A toggle menu view supports displaying a list of options on a screen horizontally (side to side, in a single row) similar to a [Horizontal Menu](horizontal_menu_view.md). It is designed to present one of two choices easily.

## General Information

Items can be selected on a menu via the left and right cursor keys, or by selecting them via a `hotKey` - see ***Hot Keys*** below.

:information_source: A toggle menu view is defined with a percent (%) and the characters TM, followed by the view number (if used.) For example: `%TM1`

:information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets focus text style. See **Text Styles** in [MCI](../mci.md)|
| `focus` | If set to `true`, establishes initial focus |
| `submit` | If set to `true` any `accept` action upon this view will submit the encompassing **form** |
| `hotKeys` | Sets hot keys to activate specific items. See **Hot Keys** below |
| `hotKeySubmit` | Set to submit a form on hotkey selection |
| `argName` | Sets the argument name for this selection in the form |
| `items` | List of items to show in the menu. Must include exactly two (2) items. See **Items** below. |


### Hot Keys

A set of `hotKeys` are used to allow the user to press a character on the keyboard to select that item, and optionally submit the form.

Example:

```
hotKeys: { A: 0, B: 1, Q: 1 }
hotKeySubmit: true
```
This would select and submit the first item if `A` is typed, second if `B`, etc.

### Items

A toggle menu, similar to other menus, take a list of items to display in the menu. Unlike other menus, however, there must be exactly two items in a toggle menu. For example:


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
["First item", "Second item"]
```

## Example

![Example](../../assets/images/toggle_menu_view_example1.gif "Toggle menu")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
TM2: {
  focus: true
  submit: true
  argName: navSelect
  focusTextStyle: upper
  items: [ "yes", "no" ]
}
```
</div>
</details>

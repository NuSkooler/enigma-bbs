---
layout: page
title: Spinner Menu View
---
## Spinner Menu View
A spinner menu view supports displaying a set of times on a screen as a list, with one item displayed at a time. This is generally used to pick one option from a list. Some examples could include selecting from a list of states, themes, etc.

## General Information

Items can be selected on a menu via the cursor keys or by selecting them via a `hotKey` - see ***Hot Keys*** below.

> :information_source: A spinner menu view is defined with a percent (%) and the characters SM, followed by the view number (if used.) For example: `%SM1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets focus text style. See **Text Styles** in [MCI](../mci.md)|
| `focus` | If set to `true`, establishes initial focus |
| `width` | Sets the width of a view on the display (default 15)|
| `submit` | If set to `true` any `accept` action upon this view will submit the encompassing **form** |
| `hotKeys` | Sets hot keys to activate specific items. See **Hot Keys** below |
| `hotKeySubmit` | Set to submit a form on hotkey selection |
| `argName` | Sets the argument name for this selection in the form |
| `justify` | Sets the justification of each item in the list. Options: left (default), right, center |
| `itemFormat` | Sets the format for a list entry. See **Entry Formatting** in [MCI](../mci.md) |
| `fillChar` | Specifies a character to fill extra space in the menu with. Defaults to an empty space |
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

A spinner menu, similar to other menus, take a list of items to display in the menu. For example:


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

## Example

![Example](../../assets/images/spinner_menu_view_example1.gif "Spinner menu")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
SM1: {
  submit: true
  argName: themeSelect
  items: [
    {
      text: Light
      data: light
    }
    {
      text: Dark
      data: dark
    }
    {
      text: Rainbow
      data: rainbow
    }
    {
      text: Gruvbox
      data: gruvbox
    }
  ]
}

```
</div>
</details>

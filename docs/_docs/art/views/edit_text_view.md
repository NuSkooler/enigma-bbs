---
layout: page
title: Edit Text View
---
## Edit Text View
An edit text view supports editing form values on a screen. This can be for new entry as well as editing existing values defined by the module.

## General Information

> :information_source: An edit text view is defined with a percent (%) and the characters ET, followed by the view number. For example: `%ET1`. This is generally used on a form in order to allow a user to enter or edit a text value.

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets the focus text style. See **Text Styles** in [MCI](../mci.md) |
| `width` | Sets the width of a view for the text edit (default 15)|
| `argName` | Sets the argument name for this value in the form |
| `maxLength` | Sets the maximum number of characters that can be entered |
| `focus` | Set to true to capture initial focus |
| `justify` | Sets the justification of the text entry. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space in the text entry with. Defaults to an empty space |

## Example

![Example](../../assets/images/edit_text_view_example1.gif "Edit Text View")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
ET1: {
  maxLength: @config:users.usernameMax
  argName: username
  focus: true
}
```
</div>
</details>

---
layout: page
title: Mask Edit Text View
---
## Mask Edit Text View
A mask edit text view supports editing form values on a screen. This can be for new entry as well as editing existing values defined by the module. Unlike a edit text view, the mask edit text view does not show the current value until the field is focused.

## General Information

:information_source: A mask edit text view is defined with a percent (%) and the characters ME, followed by the view number. For example: `%ME1`. This is generally used on a form in order to allow a user to enter or edit a text value.

:information_source: See [Art](../general.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [Art](../general.md) |
| `width` | Sets the width of a view for the text edit (default 15)|
| `argName` | Sets the argument name for this value in the form |
| `maxLength` | Sets the maximum number of characters that can be entered |
| `focus` | Set to true to capture initial focus |
| `justify` | Sets the justification of the text entry. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space in the text entry with. Defaults to an empty space |

## Example

![Example](../../assets/images/mask_edit_text_view_example1.gif "Masked Text Edit View")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
ME1: {
  maxLength: @config:users.webMax
  argName: web
}
```
</div>
</details>

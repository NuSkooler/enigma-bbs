---
layout: page
title: Button View
---
## Button View
A button view supports displaying a button on a screen.

## General Information

:information_source: A button view is defined with a percent (%) and the characters BT, followed by the view number. For example: `%BT1`

:information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `text` | Sets the text to display on the button |
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets focus text style. See **Text Styles** in [MCI](../mci.md)|
| `width` | Sets the width of a view to display one or more columns horizontally (default 15)|
| `focus` | If set to `true`, establishes initial focus |
| `submit` | If set to `true` any `accept` action upon this view will submit the encompassing **form** |
| `argName` | Sets the argument name for this selection in the form |
| `justify` | Sets the justification of each item in the list. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space longer than the text length. Defaults to an empty space |
| `textOverflow` | If the button text cannot be displayed due to `width`, set overflow characters. See **Text Overflow** below |

### Text Overflow

The `textOverflow` option is used to specify what happens when a text string is too long to fit in the `width` defined.

:information_source: If `textOverflow` is not specified at all, a button can become wider than the `width` if needed to display the text value.

:information_source: Setting `textOverflow` to an empty string `textOverflow: ""` will cause the item to be truncated if necessary without any characters displayed

:information_source: Otherwise, setting `textOverflow` to one or more characters will truncate the value if necessary and display those characters at the end. i.e. `textOverflow: ...`

## Example

![Example](../../assets/images/button_view_example1.gif "Button")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
BT1: {
  submit: true
  justify: center
  argName: btnSelect
  width: 17
  focusTextStyle: upper
  text: Centered button
}
```
</div>
</details>

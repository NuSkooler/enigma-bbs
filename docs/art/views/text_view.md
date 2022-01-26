---
layout: page
title: Full Menu View
---
## Full Menu View
A text label view supports displaying simple text on a screen.

## General Information

:information_source: A text label view is defined with a percent (%) and the characters TL, followed by the view number. For example: `%TL1`

:information_source: See [Art](../general.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `text` | Sets the text to display on the button |
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [Art](../general.md) |
| `width` | Sets the width of a view to display one or more columns horizontally (default 15)|
| `argName` | Sets the argument name for this selection in the form - *Not normally used for text labels* |
| `justify` | Sets the justification of each item in the list. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space in the menu with. Defaults to an empty space |
| `textOverflow` | If a single column cannot be displayed due to `width`, set overflow characters. See **Text Overflow** below |

### Text Overflow

The `textOverflow` option is used to specify what happens when a text string is too long to fit in the `width` defined.

:information_source: If `textOverflow` is not specified at all, a text label can become wider than the `width` if needed to display the text value.

:information_source: Setting `textOverflow` to an empty string `textOverflow: ""` will cause the item to be truncated if necessary without any characters displayed

:information_source: Otherwise, setting `textOverflow` to one or more characters will truncate the value if necessary and display those characters at the end. i.e. `textOverflow: ...`

## Example

![Example](../../assets/images/text_label_view_example1.png "Text label")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
TL1: {
  text: Text label
}
```
</div>
</details>

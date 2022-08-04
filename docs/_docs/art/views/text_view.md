---
layout: page
title: Text View
---
## Text View
A text label view supports displaying simple text on a screen.

## General Information

> :information_source: A text label view is defined with a percent (%) and the characters TL, followed by the view number. For example: `%TL1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `text` | Sets the text to display on the label |
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `width` | Sets the width of a view to display horizontally (default 15)|
| `justify` | Sets the justification of the text in the view. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space in the view with. Defaults to an empty space |
| `textOverflow` | Set overflow characters to display in case the text length is less than the width. See **Text Overflow** below |

### Text Overflow

The `textOverflow` option is used to specify what happens when a text string is too long to fit in the `width` defined.

> :information_source: If `textOverflow` is not specified at all, a text label can become wider than the `width` if needed to display the text value.

> :information_source: Setting `textOverflow` to an empty string `textOverflow: ""` will cause the item to be truncated if necessary without any characters displayed

> :information_source: Otherwise, setting `textOverflow` to one or more characters will truncate the value if necessary and display those characters at the end. i.e. `textOverflow: ...`

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

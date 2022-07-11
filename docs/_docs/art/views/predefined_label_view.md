---
layout: page
title: Predefined Label View
---
## Predefined Label View
A predefined label view supports displaying a predefined MCI label on a screen.

## General Information

:information_source: A predefined label view is defined with a percent (%) and the characters PL, followed by the view number and then the predefined MCI value in parenthesis. For example: `%PL1(VL)` to display the Version Label. *NOTE*: this is an alternate way of placing MCI codes, as the MCI can also be placed on the art page directly with the code. For example `%VL`. The difference between these is that the PL version can have additional formatting options applied to it.

:information_source: See *Predefined Codes* in [MCI](../mci.md) for the list of available MCI codes.

:information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `justify` | Sets the justification of the MCI value text. Options: left (default), right, center |
| `fillChar` | Specifies a character to fill extra space in the view. Defaults to an empty space |
| `width` | Specifies the width that the value should be displayed in (default 3) |
| `textOverflow` | If the MCI is wider than width, set overflow characters. See **Text Overflow** below |

### Text Overflow

The `textOverflow` option is used to specify what happens when a predefined MCI string is too long to fit in the `width` defined.

:information_source: If `textOverflow` is not specified at all, a predefined label view can become wider than the `width` if needed to display the MCI value.

:information_source: Setting `textOverflow` to an empty string `textOverflow: ""` will cause the item to be truncated if necessary without any characters displayed

:information_source: Otherwise, setting `textOverflow` to one or more characters will truncate the value if necessary and display those characters at the end. i.e. `textOverflow: ...`

## Example

![Example](../../assets/images/predefined_label_view_example1.png "Predefined label")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
PL1: {
  textStyle: upper
}
```
</div>
</details>

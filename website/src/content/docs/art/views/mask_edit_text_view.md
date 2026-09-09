---
layout: page
title: Mask Edit Text View
---
## Mask Edit Text View
A mask edit text view supports editing form values on a screen. This can be for new entry as well as editing existing values. Unlike a edit text view, the mask edit text view uses a mask pattern to specify what format the values should be entered in.

## General Information

> :information_source: A mask edit text view is defined with a percent (%) and the characters ME, followed by the view number. For example: `%ME1`. This is generally used on a form in order to allow a user to enter or edit a text value.

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `textStyle` | Sets the standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md) |
| `focusTextStyle` | Sets the focus text style. See **Text Styles** in [MCI](../mci.md) |
| `argName` | Sets the argument name for this value in the form |
| `maxLength` | Sets the maximum number of characters that can be entered. *Not normally useful, set the mask pattern as needed instead* |
| `focus` | Set to true to capture initial focus |
| `maskPattern` | Sets the mask pattern. See **Mask Pattern** below |
| `fillChar` | Specifies a character to fill extra space in the text entry with. Defaults to an empty space |

### Mask Pattern

A `maskPattern` must be set on a mask edit text view (not doing so will cause the view to be focusable, but no text can be input). The `maskPattern` is a set of characters used to define input, as well as optional literal characters that can be entered into the pattern that will always be entered into the input. The following mask characters are supported:

| Mask Character | Description  |
|----------------|--------------|
| # | Numeric input, one of 0 through 9 |
| A | Alphabetic, one of a through z or A through Z |
| @ | Alphanumeric, matches one of either Numeric or Alphabetic above |
| & | Printable, matches one printable character including spaces |

Any value other than the entries above is treated like a literal value to be displayed in the patter. Multiple pattern characters are combined for longer inputs. Some examples could include:

| Pattern | Description  |
|---------|--------------|
| `AA`      | Matches up to two alphabetic characters, for example a state name (i.e. "CA") |
| `###`     | Matches up to three numeric characters, for example an age (i.e. 25) |
| `###-###-####` | A pattern matching a phone number with area code |
| `##/##/####` | Matches a date of type month/day/year or day/month/year (i.e. 01/01/2000) |
| `##-AAA-####` | Matches a date of type day-month-year (i.e. 01-MAR-2010) |
| `# foot ## inches`| Matches a height in feet and inches (i.e. 6 foot 2 inches) |


## Example

![Example](../../assets/images/mask_edit_text_view_example1.gif "Masked Text Edit View")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
ME1: {
  argName: height
  fillChar: "#"
  maskPattern: "# ft. ## in."
}
```
</div>
</details>

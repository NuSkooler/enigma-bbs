---
layout: page
title: Status Bar View
---
## Status Bar View
A status bar view is a single-line text label that automatically re-renders its content on a configurable interval. This makes it useful for displaying live information such as the current time, active node count, or user statistics that change while a screen is displayed.

## General Information

> :information_source: A status bar view is defined with a percent (%) and the characters SB, followed by the view number. For example: `%SB1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

The `text` property is treated as a **format template**: it is re-evaluated on every refresh tick so that embedded MCI codes (e.g. `{CT}` for current time, `{AN}` for active node count) always reflect up-to-date values.

### Properties

| Property | Description |
|----------|-------------|
| `text` | Format template for the label. Supports pipe color codes and any predefined MCI code in `{CODE}` syntax (e.g. `{CT}`, `{UN}`, `{AN}`). |
| `width` | Width of the view in columns (default: 15). |
| `refreshInterval` | Milliseconds between automatic refreshes (default: `0` — no auto-refresh). Set to e.g. `1000` to refresh every second. |
| `textStyle` | Standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md). |
| `justify` | Text justification: `left` (default), `right`, or `center`. |
| `fillChar` | Character used to fill unused space to the right of the text (default: space). |
| `textOverflow` | Characters to display when text is longer than `width`. See [Text View](text_view.md) for details. |

### MCI Codes in Text

Any predefined MCI code wrapped in `{` `}` is substituted each refresh cycle. For example:

```hjson
text: "|07Time: |15{CT}|07  Nodes: |15{AN}"
```

See [MCI Codes](../mci.md#predefined-codes) for the full list of available predefined codes.

## Example

```
%SB1%SB1
```

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">

```
SB1: {
  text: "|07{DT} {CT}  [{AN} active]"
  width: 40
  refreshInterval: 1000
  justify: right
}
```
</div>
</details>

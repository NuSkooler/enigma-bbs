---
layout: page
title: Multi Line Edit Text View
---
## Multi Line Edit Text View
A text display / editor designed to edit or display a message.

## General Information

> :information_source: A multi line edit text view is defined with a percent (%) and the characters MT, followed by the view number. For example: `%MT1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

### Properties

| Property    | Description  |
|-------------|--------------|
| `text` | Sets the text to display - only useful for read-only and preview, otherwise use a specific module |
| `width` | Sets the width of a view to display horizontally (default 15) |
| `height` | Sets the height of a view to display vertically |
| `argName` | Sets the argument name for the form |
| `mode` | One of edit, preview, or read-only. See **Mode** below |
| `hyperlinks` | When `true`, URLs in the displayed text are rendered as clickable OSC 8 hyperlinks on supported terminals (IcyTerm, SyncTERM, VTX, and modern *nix terminals). Only active in `preview` or `read-only` mode; ignored in `edit` mode. Defaults to `false`. |

### Mode

The mode of a multi line edit text view controls how the view behaves. The following modes are allowed:

| Mode    | Description  |
|-------------|--------------|
| edit | edit the contents of the view |
| preview | preview the text, including scrolling |
| read-only | No scrolling or editing the view |

> :information_source: If `mode` is not set, the default mode is "edit"

> :information_source: With mode preview, scrolling the contents is allowed, but is not with read-only.

## Example

![Example](../../assets/images/multi_line_edit_text_view_example1.gif "Multi Line Edit Text View")

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">
```
ML1: {
  width: 79
  argName: message
  mode: edit
}
```

Viewer with clickable hyperlinks:
```
MT1: {
  width: 79
  mode: preview
  hyperlinks: true
}
```
</div>
</details>

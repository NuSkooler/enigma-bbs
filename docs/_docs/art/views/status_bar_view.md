---
layout: page
title: Status Bar View
---
## Status Bar View
A status bar view (`%SB`) is a single-line view that operates in one of two modes:

- **Single mode** (no `panels` option): behaves like a `TextView` with an optional timed auto-refresh. Useful for clocks, counters, and other self-updating labels.
- **Panel mode** (`panels` array): the view is divided into independently-addressable named slots, each with its own width, alignment, color, fill character, and optional auto-refresh template. Code updates individual panels via `setPanel()` / `setPanels()` without touching the others.

## General Information

> :information_source: A status bar view is defined with a percent (%) and the characters SB, followed by the view number. For example: `%SB1`

> :information_source: See [MCI](../mci.md) for general information on how to use views and common configuration properties available for them.

---

## Single Mode

The `text` property is treated as a **format template**: it is re-evaluated on every refresh tick so that embedded MCI codes (e.g. `{CT}` for current time, `{AN}` for active node count) always reflect up-to-date values.

### Single-Mode Properties

| Property | Description |
|----------|-------------|
| `text` | Format template for the label. Supports pipe color codes and any predefined MCI code in `{CODE}` syntax (e.g. `{CT}`, `{UN}`, `{AN}`). |
| `width` | Width of the view in columns (default: 15). |
| `refreshInterval` | Milliseconds between automatic refreshes (default: `0` — no auto-refresh). Set to e.g. `1000` to refresh every second. |
| `textStyle` | Standard (non-focus) text style. See **Text Styles** in [MCI](../mci.md). |
| `justify` | Text justification: `left` (default), `right`, or `center`. |
| `fillChar` | Character used to fill unused space (default: space). |
| `textOverflow` | Characters to display when text is longer than `width`. See [Text View](text_view.md) for details. |

### MCI Codes in Text

Any predefined MCI code wrapped in `{` `}` is substituted each refresh cycle. For example:

```hjson
text: "|07Time: |15{CT}|07  Nodes: |15{AN}"
```

See [MCI Codes](../mci.md#predefined-codes) for the full list of available predefined codes.

### Single-Mode Example

```
%SB1%SB1
```

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">

```hjson
SB1: {
  text: "|07{DT} {CT}  [{AN} active]"
  width: 40
  refreshInterval: 1000
  justify: right
}
```
</div>
</details>

---

## Panel Mode

Panel mode divides the view into independently-addressable slots. Each panel has its own fixed or fill width, alignment, color, and optional auto-refresh template. Code updates individual panels by name or index via `setPanel()` / `setPanels()`.

### SB-Level Panel Options

| Property | Description |
|----------|-------------|
| `panels` | Array of panel configuration objects. Presence of this key activates panel mode. |
| `width` | Total width of the entire status bar in columns. |
| `anchor` | `left` (default) or `right` — which end `panels[0]` is attached to. `right` reverses draw order so the first panel in the config is the rightmost one. |
| `justify` | How the panel group sits within the total view width: `left` (default), `center`, or `right`. |
| `separator` | Pipe-code string drawn between panels (default: `""`). Example: `" "` for a single space. |

### Per-Panel Options

| Property | Description |
|----------|-------------|
| `name` | String key for `setPanel('name', value)` calls from code. Falls back to index if omitted. |
| `width` | Fixed number of columns, or `"fill"` (one fill panel allowed per SB — takes remaining space). |
| `justify` | Alignment within the panel slot: `left` (default), `center`, or `right`. |
| `styleSGR1` | Pipe-code string for the panel's text color (e.g. `\|09` for bright blue). |
| `textStyle` | `normal`, `bold`, `reverse`, `upper`, `lower`, etc. Applied via `stylizeString`. |
| `fillChar` | Pipe-code string for the pad character (e.g. `\|08·` for a dim dot). Default: space. |
| `overflow` | `clip` (default — truncate from right) or `clip-left` (truncate from left). |
| `text` | Static or format template for the panel's initial value. Supports pipe codes and `{CODE}` MCI tokens. If `refreshInterval` is also set the panel auto-refreshes on a timer; without it the value is evaluated once at init and remains fixed (until `setPanel()` overwrites it). |
| `refreshInterval` | ms between auto-refreshes for this panel. Overrides the SB-level default. `0` = event-driven only. |

### Code API

For panels driven from module code rather than auto-refresh templates:

```javascript
// Update one panel by name (or by index if a number is passed):
statusBarView.setPanel('mode', 'INS');
statusBarView.setPanel('pos', '01,01');

// Update multiple panels with a single redraw:
statusBarView.setPanels({ mode: 'OVR', pos: '12,40' });
```

Values passed to `setPanel` / `setPanels` are processed through pipe-code conversion and `textStyle` — plain strings are fine for simple indicators.

### Panel Mode Example — FSE Editor Footer

The full-screen editor (`fse.js`) uses a single `%SB1` in `MSGEFTR.ANS` to display the cursor position and insert/overtype mode indicator side-by-side:

```
%SB1%SB1
```

<details>
<summary>Configuration fragment (expand to view)</summary>
<div markdown="1">

```hjson
2: {
    mci: {
        SB1: {
            width:     9
            anchor:    left
            justify:   left
            separator: " "
            panels: [
                {
                    name:    mode
                    width:   3
                    justify: right
                }
                {
                    name:    pos
                    width:   5
                    justify: left
                }
            ]
        }
    }
}
```

This produces output like `INS 01,01` (3-char mode panel + 1-char separator space + 5-char position panel). The `mode` and `pos` panels are updated from code via `setPanel('mode', 'INS')` and `setPanel('pos', '01,01')`.

To add static label prefixes entirely from config, give each panel a `text` value and widen accordingly:

```hjson
panels: [
    {
        name:  modeLabel
        width: 4
        text:  "md: "
    }
    {
        name:    mode
        width:   3
        justify: right
    }
]
```

</div>
</details>

---
title: Table View
description: "%TV — a scrolling list with columns, group rows, a header and sorting."
sidebar:
    order: 23
---
A table view shows a list of rows down the screen, like a [Vertical Menu](vertical_menu_view.md), but each row can be laid out in **columns**. Rows can be grouped under **group rows** (`───── fsxNet ─────` dividers), some rows can be made unselectable, a **header** can label the columns, and the list can be **sorted** by a column. The cursor keys, Page Up, Page Down, Home and End only ever land on rows that can be selected.

A table view without columns draws each row from `itemFormat` / `focusItemFormat`, so `%TV` can stand in for `%VM`.

:::note
A table view is defined with a percent (%) and the characters TV, followed by the view number. For example: `%TV1`
:::

:::note
See [Views](views.md) for the **common view properties** and the **common menu view properties**. A table view accepts all of them except `focusItems`, `itemSpacing` and `itemHorizSpacing`, and `focusPrefix` / `focusSuffix`, which it does not support.
:::

## Rows

Rows usually come from the module that owns the screen. A row is a string, or an object of fields. The fields keep their real types (numbers stay numbers, dates stay dates), so sorting and formatting work on the values themselves. A table view reads these fields of a row:

| Field | Description |
|-------|-------------|
| `kind` | `item` (the default) or `group`. A group row is a divider drawn across the whole view from the `group` format |
| `selectable` | `true` or `false`. Defaults to `true` for items and `false` for group rows. Navigation skips rows that cannot be selected. A table whose rows are all unselectable is read-only: its rows are drawn, nothing is highlighted, and the cursor keys scroll it |
| `state` | Any name the module chooses, e.g. `new` or `personal`. Picks a colour from `stateSGR` |
| `key` | A stable ID for the row, so focus stays on the same row when the list is refreshed. Falls back to `data` |
| `data` | The value submitted with the form. When a row has no `data`, its index is submitted |
| `text` | The field shown when there are no columns and no `itemFormat` |

Strings, and objects without these fields, behave as they do on a vertical menu.

## Properties

In addition to the common view and menu view properties, a table view accepts:

| Property | Description |
|----------|-------------|
| `columns` | The columns, keyed by an ID you choose. See **Columns** below |
| `columnOrder` | Column IDs in the order they are drawn, e.g. `[ "flag", "area", "new" ]`. A column left out is not drawn. Defaults to the order of `columns` |
| `header` | `true` to draw a header row above the list (it takes one of the `height` rows). Defaults to `false`: many screens draw the header in the art instead |
| `headerSGR` | Colour of the header row, e.g. `"\|00\|15"` |
| `headerFormat` | A format for the header row instead of the column labels. The module supplies its fields |
| `separator` | Drawn between columns, with its own colour, e.g. `" \|08│ "` |
| `focusSGR` | Colour of the focused row (the lightbar), e.g. `"\|00\|17"`. Defaults to the focus colour from the art |
| `focusColumns` | Column IDs to highlight on the focused row. Defaults to the whole row. Both the lightbar and a column's `focusSGR` apply only to these columns |
| `altRowSGR` | Colour added to every other row (zebra stripes). The stripes restart after each group row |
| `stateSGR` | Colour per row `state`, e.g. `{ new: "\|15", personal: "\|13" }` |
| `group` | How group rows are drawn: `format` (default `{text}`; sees every field of the group row), `fillChar` (may carry a colour: `"\|08─"`), `justify` and `sgr` |
| `emptyText` | Drawn on the first row when there are no rows other than group rows (an empty list, or only group rows). Defaults to blank |
| `sort` | The sort, see **Sorting** below. Without `sort`, rows stay in the order the module gives them |
| `sortable` | Column IDs that the module's "change sort" key cycles through. Defaults to every column drawn |
| `sortIndicator` | Drawn after the label of the sorted column in the header. Defaults to `{ asc: "▲", desc: "▼" }` (CP437 `0x1E` / `0x1F`) |
| `focusItemAtTop` | If `true`, the focused row is scrolled to the top. Defaults to `false`: the list scrolls as little as possible |
| `itemFormat` / `focusItemFormat` | Format of a row when there are no `columns`, as on a vertical menu. See **Entry Formatting** in [MCI](../mci.md) |
| `textOverflow` | Drawn where a value is cut, e.g. `".."`. Applies to columns that do not set their own |
| `plainFields` | Fields whose pipe codes are shown as typed, e.g. `[ "subject", "from.name" ]`. The module usually sets these; a value set here replaces the module's. See **Pipe Codes** below |

### Columns

Each entry in `columns` describes one column:

| Property | Description |
|----------|-------------|
| `field` | The row field shown. Defaults to the column ID |
| `label` | Header label |
| `type` | `text`, `number`, `date` or `bool`. Worked out from the values when not set. Decides the default justification, how the column sorts, and how values are formatted |
| `width` | A number of columns, `fill`, or a percentage of the view width less the separators, e.g. `"25%"`. `fill` columns (and columns without a `width`) share the space left over. When the numbers and percentages add up to more than the view, they shrink in proportion and `fill` columns get nothing |
| `justify` | `left`, `right` or `center`. Numbers default to `right`, everything else to `left` |
| `textOverflow` | Drawn where a value is cut: `".."`, `"»"`, `">"`. Without it, values are simply cut. A marker wider than the column is cut to fit |
| `fillChar` | Fills the rest of the column. May carry a colour |
| `padding` | Blank columns inside the column, as a number (both sides) or `[ left, right ]` |
| `format` | A format for the value, e.g. `"{value:,}"`. It sees `{value}` and every field of the row, and transformers such as `{value!countAbbr}` work. See **Entry Formatting** in [MCI](../mci.md) |
| `dateFormat` | How a `date` is shown, e.g. `MMM DD`. Defaults to the theme's short date format |
| `boolText` | What a `bool` shows, as `[ true, false ]`. Defaults to `[ "Yes", "No" ]`, also for an entry left out |
| `nullText` | Shown when the value is empty (missing, `null` or `""`). Defaults to blank |
| `sgr` | Colour of the column |
| `focusSGR` | Colour of the column on the focused row |
| `pipeCodes` | `true` or `false`: whether pipe codes in this column's values are shown as colour. Overrides the module's `plainFields` |
| `minTermWidth` | Hide the column on terminals narrower than this, e.g. `80`. `fill` columns take the space it leaves, which helps on 40-column terminals |
| `sortOrder` | `asc` or `desc`: the order used when the user's sort key moves to this column. Defaults to `asc` |

A `date` column takes a Date, a moment, an ISO 8601 string (`2026-11-17T21:04:00`) or epoch milliseconds from the module. Set `type: date` for the last two; only real dates are recognised without it. Any other value is shown as given.

:::note
CP437 has no ellipsis character: a `…` reaches CP437 callers as `?`. Use `..`, `~` or `»` (CP437 `0xAF`) for `textOverflow`.
:::

### Colours

A cell's colour is built up in this order, each later colour overriding only what it sets:

1. the view's colour: `focusSGR` on the focused row, else the normal colour (plus `altRowSGR` on striped rows)
2. the column's `sgr`
3. the row's `stateSGR`
4. the column's `focusSGR`, on the focused row only

Because the lightbar comes first, a column colour such as `|03` stays visible inside it; set the column's `focusSGR` to change that. Colours inside a `format` or a value apply after all of these.

### Sorting

```hjson
sort: {
    column: new
    order: desc
    then: area
}
```

- `column` is a column ID (or, for a field that has no column, the field name). `order` is `asc` (default) or `desc`. `then` is a tie-breaker column, or a list of them; each can be `{ column: area, order: desc }`.
- Rows are sorted **within their groups**: group rows stay where they are.
- Numbers sort as numbers (`9` before `10`), dates by time, text without regard to case. Empty values always sort last, and so do values that do not fit the column's `type` (e.g. `n/a` in a `number` column). In a column without a `type`, numbers come before dates, booleans and text.
- `sort: true` sorts on `text`, as on a vertical menu.
- A module can let the user change the sort with a key: it binds keys to the view's `cycleSort()` (next column in `sortable`) and `toggleSortOrder()`. `cycleSort()` skips columns hidden by `minTermWidth`, even when `sortable` lists them.

### Pipe Codes

Pipe codes in formats, labels, `separator`, `group`, `emptyText` and other text you write in the configuration are always shown as colour. Values in rows are shown as colour too, unless the module marks a field as **plain**: text typed by users (subjects, user names) is shown exactly as typed, so a `|04` in a subject does not change colours. Control characters (such as an ESC sequence) are removed from plain fields. Plain fields can be nested (`from.name`) and are plain wherever they are formatted: in columns, `group`, `itemFormat` and `headerFormat`. A column's `pipeCodes` overrides that either way: `true` shows the column's codes as colour, `false` shows every value in it as typed.

## Navigation

- Up and Down move to the next or previous row that can be selected, and wrap around at the ends of the list, as on a vertical menu.
- Page Up and Page Down move by a screen. At the last row Page Down goes to the first, and at the first row Page Up goes to the last.
- Home and End go to the first and last rows that can be selected.
- A hot key that points at a row that cannot be selected is ignored.
- When the list scrolls back up to the first row of a group, its group row is brought into view with it.
- When nothing can be selected (an empty table, only group rows, or only unselectable rows), Enter submits `null` for the view's `argName`; a module must expect it.
- With no selectable rows but some item rows, the rows are drawn and the cursor keys scroll the table.

## Example

A list of message areas by conference, newest first:

<details>
<summary>Configuration fragment (expand to view)</summary>

```hjson
TV1: {
    height: 15
    header: true
    headerSGR: "|00|15"
    separator: " |08│ "
    focusSGR: "|00|17"
    emptyText: "No new messages"
    sort: {
        column: new
        order: desc
        then: area
    }
    sortable: [ "area", "new", "last" ]
    columnOrder: [ "flag", "area", "total", "new", "yours", "last" ]
    columns: {
        flag: {
            field: newIndicator
            width: 3
        }
        area: {
            field: areaName
            label: Area
            width: fill
            textOverflow: ".."
        }
        total: {
            field: total
            label: Total
            type: number
            width: 6
            format: "{value:,}"
            sgr: "|03"
        }
        new: {
            field: newCount
            label: New
            type: number
            width: 5
            sgr: "|10"
        }
        yours: {
            field: yours
            label: Yours
            type: number
            width: 5
            nullText: "-"
        }
        last: {
            field: lastPostTs
            label: Last Post
            type: date
            dateFormat: MMM DD
            width: 9
            minTermWidth: 80
        }
    }
    group: {
        format: "|08───── |15{confName} "
        fillChar: "|08─"
    }
    stateSGR: {
        new: "|15"
        personal: "|13"
    }
}
```

</details>

## Theming

A table view is configured in `menu.hjson` and `theme.hjson` like any other view. In `theme.hjson`, the table view's own object properties, `columns`, `stateSGR`, `sort`, `group` and `sortIndicator`, are **merged** with the menu's, so a theme can change one column's colour without repeating the table:

```hjson
mci: {
    TV1: {
        columns: {
            new: {
                sgr: "|11"
            }
        }
        sort: {
            order: asc
        }
    }
}
```

Lists inside them (`sort.then`) and every other property are replaced as usual.

:::note
The merge applies only to MCI entries named `TV`, e.g. `TV1`. On every other view, a nested value in `theme.hjson`, such as a status bar's `panels`, **replaces** the menu's value as a whole, as it always has. A menu that keeps a `VM1` entry for `%TV1` art still works, but its nested values are replaced; rename the entry to `TV1` to get the merge.
:::

## For Module Authors

A module fills the table and reacts to it through the view:

| Method | Description |
|--------|-------------|
| `setItems(rows, { keepFocus })` | Set the rows. With `keepFocus: true` focus stays on the same row (by `key`, else at the same index), moving to the nearest selectable row if that one cannot be selected now; without it focus goes to the first row that can be selected. A sort set with `setSort()` or `cycleSort()` is kept. Does not redraw |
| `updateItem(key, fields)` | Merge `fields` into the row with this `key` (falling back to `data`; numbers are keys too) and redraw that row only; focus and scroll stay put. The row is not moved by the sort; call `setSort()` to re-sort. A change of `kind` or `selectable` redraws the table. Returns `false` if there is no such row |
| `updateItemAt(index, fields)` | The same, by the row's position on screen (after sorting) |
| `getFocusedItem()` | The focused row, or `null` when nothing can be selected |
| `findIndex(fn)` | Index of the first row for which `fn(row, index)` is true, else `-1` |
| `focusNextMatching(fn, { wrap })` / `focusPreviousMatching(fn, { wrap })` | Focus the next (previous) selectable row for which `fn(row, index)` is true, e.g. the next area with new messages. `wrap` defaults to `true`. Returns the index, or `-1` with focus unchanged |
| `setSort(column, order)` / `cycleSort()` / `toggleSortOrder()` / `getSort()` | Change or read the sort. `setSort(null)` goes back to the module's order. Focus stays on the same row. A sort set this way stays in effect across `setItems()`. `setSort()` accepts a column hidden by `minTermWidth`, but the header has nowhere to show the indicator then |
| `setDefaults({ … })` | The module's own defaults for any table view property (`columns`, `sort`, `group`, `textOverflow`…). They sit beneath the menu and theme: built-in defaults < module defaults < `menu.hjson` < `theme.hjson`, with the same merge of `columns` and the other object properties. Call it before `setItems()` |
| `setPlainFields([ … ])` | The module's plain fields. An operator's `plainFields` in `menu.hjson` or `theme.hjson` replaces them, and a column's `pipeCodes` overrides both |
| `setHeaderData({ … })` | Fields for `headerFormat` |

- `getData()` returns the focused row's `data` whenever it is set, numbers included, else its index; `null` when nothing can be selected.
- The `index update` event passes the row as a second argument: `(index, row)`. It is not sent when nothing can be selected.
- `hotKeys` refer to rows by their position on screen, after sorting.
- `setDefaults({ height })` (or any other view property) applies when neither the menu nor the theme sets it, so it overrides a height taken from the art.
- `removeItem(index)` does not redraw, as on a vertical menu; call `redraw()`.
- The default width is the rest of the row from the view's column, as for other views (79 on an 80-column terminal at column 2).
- The focused row stays highlighted while another view has focus, as on a vertical menu.

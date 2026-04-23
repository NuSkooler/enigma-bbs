---
layout: page
title: Set Newscan Date Module
---
## Set Newscan Date Module
The `set_newscan_date` module allows setting newscan dates for message conferences and areas, the file base, or a global newscan floor. The behaviour depends on the `target` configured for the menu entry.

| Target | What it does |
|--------|-------------|
| `message` | Finds the message ID at the given date and **writes it** to `user_message_area_last_read` for the selected area(s). This is a direct pointer move — it can go backwards or forwards. |
| `file` | Moves the file base last-viewed pointer to the file ID at the given date. |
| `floor` | Stores the date as the user's `newscan_min_timestamp` property — a non-destructive floor. Per-area read pointers are untouched; the newscan engine uses `MAX(per-area pointer, id@floor)` as the effective starting point for each area. See [Configure Newscan](configure-newscan.md) for the full floor date concept. |

## Configuration
### Configuration Block
Available `config` block entries:
* `target`: `message`, `file`, or `floor`. Defaults to `message`.
* `scanDateFormat`: Format for the date entered by the user. Must match the **output** of the `%ME1` MaskEditView. Defaults to `YYYYMMDD` (matches mask `####/##/##`).

### Theming
#### Message Conference & Areas (`target: message`)
The following `itemFormat` fields are available on MCI 2 (`%SM2`) for selecting the target conf/area:
* `conf`: An object containing:
    * `confTag`: Conference tag.
    * `name`: Conference name. Also available as `{text}`.
    * `desc`: Conference description.
* `area`: An object containing:
    * `areaTag`: Area tag.
    * `name`: Area name. Also available as `{text}`.
    * `desc`: Area description.

#### File Base (`target: file`) and Floor (`target: floor`)
No `%SM2` is used — only the `%ME1` date input field is required.

When `target` is `floor`, the date field is pre-populated with the user's current floor date (if one is set), making it easy to review and adjust.

### Submit Actions
The submit action must map to `@method:scanDateSubmit` and include `scanDate` in the form data. For `target: message`, `targetSelection` (an index into the conf/area list) must also be provided.

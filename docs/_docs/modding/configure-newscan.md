---
layout: page
title: Configure Newscan Module
---
## Configure Newscan Module

The `configure_newscan` module gives users direct control over their newscan experience. From a single screen they can:

* Select exactly which message areas are included in their newscan (or scan all).
* Set or clear a **newscan floor date** — a persistent minimum timestamp that prevents old messages from appearing as new in any area the user hasn't yet read.

Changes take effect immediately; there is no save/cancel step.

---

## Newscan Area Selection

Users can toggle individual areas on or off, or flip the entire list at once. The selection is stored as a JSON array of area tags in the `newscan_area_tags` user property.

* When the property is **absent or empty**, all available areas are scanned — identical to the pre-existing behaviour.
* When specific areas are selected, only those areas appear during the newscan. Areas without access (ACS) are never shown regardless of selection state.

---

## Newscan Floor Date

The floor date is a non-destructive lower bound applied during newscan. For each area the effective scan start is:

```
MAX(per-area last-read pointer, first message ID at or after floor date)
```

This means:
* **Areas already read past the floor** are unaffected — the actual pointer wins.
* **Areas never visited** (pointer = 0) or whose pointer falls before the floor start from the floor date instead of the beginning of time.
* Marking an area as read advances its pointer past the floor naturally, after which the floor no longer has any effect on that area.

The floor is stored as an ISO 8601 timestamp in the `newscan_min_timestamp` user property.

> **New accounts** have `newscan_min_timestamp` automatically set to their account creation timestamp. Users joining a BBS with years of message history will only see posts from their join date onward — no configuration required.

To change or clear the floor, press `G` from the configure newscan screen. This navigates to the floor-date entry form (see [Set Newscan Date — `target: floor`](set-newscan-date.md)).

---

## Art

Art file: `CFGNEWSC`

---

## MCI Codes

| MCI | Description |
|-----|-------------|
| `%VM1` | Scrollable area list. Each item represents one message area across all available conferences. |
| `%TL2` | Selection status — e.g. `4 of 12 areas selected` or `All 12 areas selected`. |
| `%TL3` | Current floor date — e.g. `Floor: 2026-01-15` or `Floor: not set`. |
| `%TL10`+ | Custom range updated on focus change — see item fields below. |

### VM1 Item Fields

The following fields are available in `itemFormat` / `focusItemFormat` for `%VM1`:

| Field | Description |
|-------|-------------|
| `{selectedIndicator}` | `*` when the area is selected for newscan, ` ` (space) when not. |
| `{confName}` | Name of the conference the area belongs to. |
| `{areaName}` | Name of the message area. |
| `{desc}` | Description of the message area. Also available in `%TL10`+ via the custom range. |
| `{areaTag}` | Area tag string. |
| `{confTag}` | Conference tag string. |
| `{text}` | Same as `{areaName}` — standard list item text field. |

Example `itemFormat`:
```hjson
itemFormat: "|00|15{selectedIndicator} |03{confName:<14.14} |11{areaName}"
focusItemFormat: "|00|19|15{selectedIndicator} {confName:<14.14} {areaName}"
```

---

## Key Bindings

Key bindings are configured in the menu HJSON `actionKeys` block. The following `@method` actions are available:

| Action | Default key(s) | Description |
|--------|---------------|-------------|
| `toggleArea` | `space`, `enter` | Toggle the focused area on or off. |
| `toggleAllAreas` | `a` | If all areas are selected, deselect all. Otherwise, select all. |
| `setFloorDate` | `g` | Navigate to the floor-date entry menu (configurable via `setFloorDateMenu`). |
| `done` | `q`, `escape` | Return to the previous menu. |

---

## Configuration Block

| Key | Default | Description |
|-----|---------|-------------|
| `setFloorDateMenu` | `configureNewscanFloor` | Name of the menu entry to navigate to when the user presses the floor-date key. Typically points to a `set_newscan_date` entry with `target: floor`. |

---

## Menu HJSON Example

```hjson
messageBaseConfigureNewscan: {
    desc: Configure Newscan
    module: configure_newscan
    art: CFGNEWSC
    config: {
        setFloorDateMenu: messageBaseSetNewscanFloor
    }
    form: {
        0: {
            mci: {
                VM1: {
                    focus: true
                    argName: areaIndex
                    height: 10
                }
                TL2: { }
                TL3: { }
            }
            actionKeys: [
                {
                    keys: [ "space", "enter" ]
                    action: @method:toggleArea
                }
                {
                    keys: [ "a", "shift + a" ]
                    action: @method:toggleAllAreas
                }
                {
                    keys: [ "g", "shift + g" ]
                    action: @method:setFloorDate
                }
                {
                    keys: [ "q", "shift + q", "escape" ]
                    action: @method:done
                }
            ]
        }
    }
}

messageBaseSetNewscanFloor: {
    desc: Set Newscan Floor
    module: set_newscan_date
    art: SETMNSDATE
    config: {
        target: floor
        scanDateFormat: YYYYMMDD
    }
    form: {
        0: {
            mci: {
                ME1: {
                    focus: true
                    submit: true
                    argName: scanDate
                    maskPattern: "####/##/##"
                }
            }
            submit: {
                *: [
                    {
                        value: { scanDate: null }
                        action: @method:scanDateSubmit
                    }
                ]
            }
            actionKeys: @reference:common.quitToPrev
        }
    }
}
```

---

## Relationship with `set_newscan_date`

The two modules serve different purposes and coexist:

| Module | Purpose |
|--------|---------|
| `configure_newscan` | Select which areas to scan; set/clear the floor date filter. |
| `set_newscan_date` (`target: message`) | Explicitly reposition per-area read pointers to a specific date — can move them forwards **or backwards**. Use this when you want to re-read past messages or catch up after a long absence. |

The floor date cannot replace `set_newscan_date` for the "go backwards / re-read" case: the floor is a lower bound (`MAX`), so setting it to a past date has no effect on areas whose pointer is already ahead of it.

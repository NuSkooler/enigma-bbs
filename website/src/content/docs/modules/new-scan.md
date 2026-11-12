---
title: New Scan Module
description: "Scan the message base, and optionally the file base, for what is new since the caller last looked."
sidebar:
    order: 9
---
The `new_scan` module looks for new messages, conference by conference and area by area (private mail first), and shows each area with something new in a message list. When the message base is done it looks for new files and shows them in a file list. The stock login sequence runs it as `fullLoginSequenceNewScan`, after asking the caller whether to (callers on their first call are not asked).

What counts as new follows the caller's last-read pointers, their newscan area selection and their newscan floor date (see [Configure Newscan](configure-newscan.md)).

## Configuration

Available `config` block entries:

| Item | Default | Description |
|------|---------|-------------|
| `newScanMessageList` | `newScanMessageList` | Menu that shows an area's new messages (a `msg_list` menu). It is given the area as `extraArgs.messageAreaTag`. |
| `newScanActivityPubList` | `newScanActivityPubList` | Menu used instead for an ActivityPub area. |
| `newScanFileBaseList` | `newScanFileBaseList` | Menu that shows the new files (a `file_area_list` menu). |
| `skipFileBase` | `false` | `true` scans the message base only: the file base is not scanned, its menu is never entered, and the caller's file base "last viewed" position is left as it was. |
| `omitMessageAreaTags` | none | Message area tags (a string or an array) not to scan. |
| `omitFileAreaTags` | none | File area tags not to scan. |
| `scanStartFmt` | `Scanning {confName} - {areaName}...` | Status text while an area is scanned. `{confName}`, `{confDesc}`, `{areaName}` and `{areaDesc}` are available. |
| `scanCompleteMsg` | `Finished newscan` | Status text when the scan is done. |

The status text goes to `%TL1`, which the menu's art must have.

`skipFileBase` is for menu trees that have no file base menus, for example the [PETSCII starter menus](../servers/loginservers/petscii.md#starter-menus-and-theme), or for a "new messages" entry on a message menu:

```hjson
messageBaseNewScan: {
    desc: New Scan
    module: new_scan
    art: NEWSCAN
    config: {
        skipFileBase: true
    }
}
```

When the scan finishes, the menu goes to its `next`, or back to the previous menu when it has none. A caller who leaves a message list with the full exit key (`fullExit` in `msg_list`) ends the whole scan.

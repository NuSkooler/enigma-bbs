# FTN Area List Fixtures

Real area/echo lists taken from FidoNet-style network info packs. These are the
actual inputs `oputil.js mb import-areas` and `oputil.js fb import-areas` are
handed by sysops, and they are messier than the parsers assume.

Kept byte exact — `.gitattributes` marks this directory `-text` so the mix of
CRLF and LF line endings survives, since that mix is part of what is being
tested.

## Provenance

Freely distributed network info packs. Message and file echo lists only; the
artwork, nodelists and documentation that ship alongside them are omitted.

| Fixture | Network | Source |
|---|---|---|
| `fsxnet-2025.na`, `fsxnet-file-2025.na` | fsxNet | `fsxnet.nz/fsxnet.zip`, pulled 2026-08 |
| `fsxnet-2018.na`, `fsxnet-file-2018.na` | fsxNet | 2018 pack, kept for the format drift below |
| `agoranet.na`, `agoranet-file.na` | AgoraNet | info pack |
| `araknet-msg.na`, `araknet-file.na` | ArakNet | info pack |
| `dorenet-msg.na` | DoRENET | info pack |
| `retronet-msg.na` | RetroNet | info pack |
| `zer0net-msg.na`, `zer0net-file.na` | Zer0net | info pack |
| `spooknet-baselist.txt` | SpookNet | info pack (ships no `.na` at all) |

## What each one demonstrates

Counts below are what the **current** parsers produce, measured, not predicted:

- `NA` — `/^([^\s]+)\s+([^\r\n]+)/gm` from `getImportEntries()` in
  `core/oputil/oputil_message_base.js`
- `ZXX` — `/Area\s+([^\s]+)\s+[0-9]\s+(?:!|\*&)\s+([^\r\n]+)/gm` from
  `importFileAreas()` in `core/oputil/oputil_file_base.js`

| Fixture | NA good/junk | ZXX | Demonstrates |
|---|---|---|---|
| `fsxnet-2025.na` | 13 / 0 | 0 | The happy path: plain `TAG  Description` |
| `retronet-msg.na` | 18 / 0 | 0 | Happy path, CRLF |
| `dorenet-msg.na` | 15 / 0 | 0 | Happy path, tabs as separators |
| `agoranet.na` | 10 / 0 | 0 | Happy path, mixed tabs and spaces |
| `araknet-msg.na` | 9 / 0 | 0 | Tabs, trailing spaces before CRLF |
| `zer0net-msg.na` | 9 / 0 | 0 | Happy path |
| `fsxnet-2018.na` | 2 / 0 | 0 | **Format drift.** Same network, same filename, 2 areas in 2018 vs 13 in 2025 — a shipped `.na` is a point-in-time snapshot, not a stable list |
| `fsxnet-file-2025.na` | 0 / 18 | 10 | **`.na` extension, FILEBONE content.** `;` comments |
| `fsxnet-file-2018.na` | 0 / 16 | 8 | Same, but `%` comments — **the comment character changed over time** |
| `agoranet-file.na` | 0 / 14 | 6 | Same trap, `%` comments |
| `zer0net-file.na` | 0 / 3 | 3 | Same trap, no comment lines at all |
| `araknet-file.na` | 3 / 0 | 0 | **File echoes in plain `TAG DESC`** — the opposite of the above |
| `spooknet-baselist.txt` | 35 / 5 | 0 | **Reversed columns**, `Description … TAG`. The worst case — see below |

## The three traps

**1. The extension does not determine the format.** Six of the eight networks
ship two `.na` files, one for message echoes and one for file echoes. Some file
lists are FILEBONE (`Area TAG 0 ! Desc`), some are plain `TAG DESC`. Parsing a
FILEBONE list with the message parser yields `Area` as the tag for every entry.
Format has to be sniffed from content.

**2. Comment lines are parsed as areas.** Neither parser skips comments. A
leading `;` or `%` line produces an entry with that character as the area tag:

```
;  FSXNet Fileecho List        ->  ftnTag: ";"   name: "FSXNet Fileecho List"
%  Agoranet Fileecho List      ->  ftnTag: "%"   name: "Agoranet Fileecho List"
```

Both characters appear in the wild, and which one a network uses has changed
over time within a single network.

**3. Silent nonsense is worse than obvious junk.** `spooknet-baselist.txt` puts
the description first and the tag last. The message parser accepts 35 entries
from it, and most pass a plausible-tag charset check:

```
tag="Aliens,"            desc="UFOs & EBEs                SN_ALIEN"
tag="Counter-Terrorism"  desc="SN_TERROR"
```

Nothing here is malformed enough to reject on shape alone. A parser must be able
to say "this file is not in a format I recognise" and refuse, rather than
returning confident garbage.

## Note

Two of the eight networks surveyed ship no machine-readable area list at all —
SpookNet uses the reversed-column `.txt` above, HappyNet embeds its list in
English prose in a `.INF` file. Any design that assumes every network ships a
parseable list is wrong.

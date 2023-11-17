---
layout: page
title: QWK Support
---

## QWK and QWK-Net Style Networks
As like all other networks such as FidoNet-Style (FTN) networks, ENiGMA½ considers QWK external to the system but can import and export the format.

### Supported Standards
QWK must be considered a semi-standard as there are many implementations. What follows is a short & incomplete list of such standards ENiGMA½ supports:
* The basic [QWK packet format](http://fileformats.archiveteam.org/wiki/QWK).
* [QWKE extensions](https://github.com/wwivbbs/wwiv/blob/master/specs/qwk/qwke.txt).
* [Synchronet BBS style extensions](http://wiki.synchro.net/ref:qwk) such as `HEADERS.DAT`, `@` kludges, and UTF-8 handling.


### Configuration
QWK configuration occurs in the `messageNetworks.qwk` config block of `config.hjson`. As QWK wants to deal with conference numbers and ENiGMA½ uses area tags (conferences and conference tags are only used for logical grouping), a mapping can be made.

> :information_source: During a regular, non QWK-Net exports, conference numbers can be auto-generated. Note that for QWK-Net style networks, you will need to create mappings however.

Example:
```hjson
{
    messageNetworks: {
        qwk: {
            areas: {
                general: {          // local ENiGMA½ area tag
                    conference: 1   // conference number to map to
                }
            }
        }
    }
}
```

### oputil
The `oputil.js` utility can export packet files, dump the messages of a packet to stdout, etc. See [the oputil documentation](../admin/oputil.md) for more information.

### Offline Readers
A few of the offline readers that have been tested with QWK packet files produced by ENiGMA½:

| Software | Status | Notes |
|----------|--------|-------|
| MultiMail/Win v0.52 | Supported | Private mail seems to break even with bundles from other systems |
| SkyReader/W32 v1.00 | Supported | Works well. No QWKE or HEADERS.DAT support. Gets confused with low conference numbers. |

There are also [many other readers](https://www.softwolves.pp.se/old/2000/faq/bwprod) for various systems.
---
title: Blue Wave Support
description: "Blue Wave offline mail packet export, echotag mapping, and tested offline readers."
sidebar:
    order: 8
---

## Blue Wave Offline Mail
Like FidoNet-style (FTN) and QWK mail, ENiGMA½ treats Blue Wave as a format external to the system. A caller can export the messages they have not read into a Blue Wave packet, download it, and read it offline in a Blue Wave reader.

Where QWK identifies a message area by a conference number, Blue Wave carries a 20 character echotag. A reply is routed by that tag, so it still reaches the right area after the sysop renumbers the message base.

### Supported Standards
* The [Blue Wave packet structures, revision 2](https://www.moon-soft.com/program/FORMAT/internet/bluewave.htm) (January 1994), and the level 3 header of November 1995.
* Packets are written at level 3: `*.INF`, `*.MIX`, `*.FTI` and `*.DAT` in an archive named for the day of the week, as the format specifies.
* Reply packets are read at level 3 (`*.UPL`) and at level 2 (`*.UPI` and `*.NET`), along with the `*.REQ` file request list.

Replies written offline are uploaded back in, so a packet is two-way. `INF_HEADER.uses_upl_file` -- how a door tells a reader to write its replies into a `*.UPL` -- is written as one when a menu on your board carries the import module, and as zero when none does, so a caller is never invited to write replies they have nowhere to send.

### Configuration
Blue Wave configuration lives in the `messageNetworks.bluewave` block of `config.hjson`. Both keys are optional: without them the packet ID is `ENIGMA` and each area is numbered and tagged from its ENiGMA½ area tag.

An area tag reaches the packet as an echotag, which is what a reply is routed by. Echotags are 20 characters, so a longer area tag is truncated and ends in three characters taken from a digest of the whole tag -- two areas that agree for twenty characters would otherwise share a tag, and replies to one would post into the other. Pin the tag yourself when it matters:

```hjson
{
    messageNetworks: {
        bluewave: {
            bbsID: MYBBS         // packet ID; 1-8 characters
            areas: {
                general: {       // local ENiGMA½ area tag
                    echotag: GENERAL   // tag as it appears in the packet
                    number: 1          // area number within the packet
                    title: "General Discussion"
                }
            }
        }
    }
}
```

### Menu Configuration
A new installation reaches the export with <kbd>B</kbd> from the message base menu, where the stock theme lists it as `b blue wave export`. A theme of your own needs that line added to its `MSGMNU` art, and a board configured before this landed keeps the menus it already has, so add the entry below to one of them.

The export is a menu module, so it can go on any menu:

```hjson
bluewaveExport: {
    desc: Blue Wave Export
    module: message_base_bluewave_export
    config: {
        progBarChar: "▒"
    }
}
```

A menu with no art has no status or progress view. The export still runs and the packet still arrives; the caller just sees nothing while it works, and `progBarChar` has nothing to draw into. A caller who presses <kbd>ESC</kbd> during the export cancels it. The finished packet is placed in their download queue and is valid until the session ends.

### What a Caller Gets
* Every message area they can read is listed in the packet, whether or not it had new mail.
* Their private mail is included as its own area.
* Message text is CP437, which is what a Blue Wave reader expects.
* An area is exported from the point it was last exported, so a second packet carries only what is new since the first.

### Uploading Replies
A new installation reaches the upload with <kbd>U</kbd> from the message base menu, listed in the stock theme as `u upload replies`. The caller picks a transfer protocol and sends the reply packet their reader wrote.

Nothing asks them which format it is. A reply packet names itself from the inside -- a Blue Wave one carries a `*.UPL`, or a `*.UPI` and `*.NET` from an older reader -- so the archive is opened and read by whichever reader matches. The format is chosen on the way *out*, at the export.

The module can go on any menu:

```hjson
offlineMailImport: {
    desc: Offline Mail Import
    module: message_base_offline_import
    config: {
        maxMessages: 500
        maxMessageLength: 65536
    }
}
```

A reply is placed by its 20 character echotag, matched against the echotags this caller's own export would have written -- so an area they cannot see was never in their packet, and a reply naming it is not imported. Each one is then checked as though they had typed it at the keyboard:

* The target area is checked for write access, and personal mail has to name a user who exists.
* The `From` name is replaced with the caller's own. A reader writes whatever name it was configured with, and the packet is no evidence of who is at the keyboard.
* A packet built for a different login is refused outright, on the name the reader copied out of `INF_HEADER.loginname`.
* `maxMessages` and `maxMessageLength` bound what one packet can carry; both are optional and default to the values above.

A reply that cannot be placed is logged and skipped rather than failing the upload, so one bad record does not cost the caller the rest of the packet.

A reply is threaded onto the message it answers. `FTI_REC.msgnum` carries the message's own ID on the way out, and the reply names it on the way back; the ID is checked against the area before anything is chained onto it. The field is 16 bits, so a message whose ID is past 65535 is exported with no number -- replies to those arrive unthreaded rather than chained onto the wrong message, and the export warns when it happens.

The same menu entry takes a QWK `*.REP` packet; see [QWK Support](./qwk.md).

### Offline Readers
| Software | Status | Notes |
|----------|--------|-------|
| [NoCarrierMail](https://github.com/andy5995/NoCarrierMail) v0.55 | Tested | Reads the packet, lists every area, counts personal mail, and renders CP437 text |
| [MultiMail](https://wmcbrine.com/mmail/) | Untested | NoCarrierMail is a fork of it and shares the Blue Wave reader |

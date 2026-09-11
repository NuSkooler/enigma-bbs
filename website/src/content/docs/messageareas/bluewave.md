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

:::note
Reply packets (`*.NEW`) are not read back in yet, so a Blue Wave packet from ENiGMA½ is currently one-way. `INF_HEADER.uses_upl_file` is therefore written as zero, which is how a door says it cannot process `*.UPL` replies.
:::

### Configuration
Blue Wave configuration lives in the `messageNetworks.bluewave` block of `config.hjson`. Both keys are optional: without them the packet ID is `ENIGMA` and each area is numbered and tagged from its ENiGMA½ area tag.

An area tag reaches the packet as an echotag, which is what a reply is routed by. Echotags are 20 characters, so a longer area tag is truncated; where that would produce two identical tags, a digit is substituted at the end. Pin the tag yourself when it matters:

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

### Offline Readers
| Software | Status | Notes |
|----------|--------|-------|
| [NoCarrierMail](https://github.com/andy5995/NoCarrierMail) v0.55 | Tested | Reads the packet, lists every area, counts personal mail, and renders CP437 text |
| [MultiMail](https://wmcbrine.com/mmail/) | Untested | NoCarrierMail is a fork of it and shares the Blue Wave reader |

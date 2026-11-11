---
title: PETSCII (Commodore) Callers
description: "How ENiGMA½ serves Commodore 64 and 128 style terminals: detection, a dedicated port, what is translated, and current limits."
sidebar:
    order: 5
---
## PETSCII

ENiGMA½ can serve Commodore-style terminals that speak PETSCII in place of ANSI: SyncTERM and IcyTerm in their C64 or C128 modes, and terminal programs on real Commodore hardware.

This is early support. The board is still ANSI inside, and what a PETSCII caller sees is your existing menus and art translated on the way out. Art drawn for an 80 column ANSI screen does not look right on a 40 column PETSCII one; native PETSCII art is planned. Nothing changes for ANSI callers.

### How a caller gets PETSCII

A session is PETSCII in either of two ways:

* **The terminal says so.** SyncTERM and IcyTerm send the Telnet terminal type `PETSCII` when set to a Commodore mode. In SyncTERM that means setting the directory entry's **Screen Mode** to a C64 or C128 mode. Choosing only a Commodore font leaves SyncTERM an ANSI terminal.
* **The port says so.** Terminal programs on real Commodore hardware usually connect as plain TCP and announce nothing. Give them their own port with an [additional Telnet listener](./telnet.md#additional-listeners):

```hjson
{
  loginServers: {
    telnet: {
      listeners: {
        c64: {
          port: 6400
          emulation: petscii
        }
      }
    }
  }
}
```

Every caller on that port is treated as PETSCII, whatever its terminal announces. A listener may also name its own `firstMenu`.

### What is translated

* **Text** is mapped to PETSCII's lower and upper case character set. Box and block drawing characters become the nearest PETSCII graphics; a character with no equivalent becomes `?`.
* **Colour.** The 16 ANSI foreground colours map to the 16 Commodore colours. PETSCII has no background colour, so a background is shown as reverse video in that colour.
* **Cursor movement.** PETSCII has no "go to row, column". ENiGMA½ tracks the cursor and sends relative moves.
* **Screen size** is what the terminal reports, otherwise 40x25.
* **Keys.** Cursor keys, HOME, INST/DEL (backspace), RETURN and F1 to F8 work as their ANSI equivalents. CLR, which SyncTERM sends for the End key, is End.
* Nothing is asked of the terminal at connect, so there is no feature detection pause.

### Limits

* Menus and art are laid out for ANSI. Expect wrapped art on a 40 column screen until a theme is made for it. A theme can declare `emulation: petscii` in its `info` block to be used for these callers.
* No hyperlinks, fonts, blink or underline.
* The bottom right screen cell is never drawn, because writing it scrolls a Commodore screen.
* Some control key combinations do not exist on a Commodore keyboard: Ctrl with E, N, Q, R, S or T share their codes with colour, cursor and delete keys.
* Doors and file transfers are passed through untranslated. Most doors expect an ANSI terminal; use the `TE` [ACS](../../configuration/acs.md) code to keep them away from PETSCII callers, for example `TE[ansi]` on a door menu entry.

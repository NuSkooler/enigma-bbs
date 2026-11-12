---
title: ATASCII (Atari) Callers
description: "How ENiGMA½ serves Atari 8-bit style terminals: detection, a dedicated port, what is translated, keys, and current limits."
sidebar:
    order: 6
---
## ATASCII

ENiGMA½ can serve Atari 8-bit style terminals that speak ATASCII in place of ANSI: SyncTERM and IcyTerm in their Atari modes, and terminal programs on real Atari hardware.

This is early support, earlier than [PETSCII](./petscii.md). The board is still ANSI inside: menus, prompts, views and art are translated on the way out. There is no native ATASCII art type and no starter menu tree yet, so an ATASCII caller sees your existing menus and art, translated, in one colour, wrapped at 40 columns. Nothing changes for ANSI callers.

### How a caller gets ATASCII

A session is ATASCII in either of two ways:

* **The terminal says so.** SyncTERM and IcyTerm send the Telnet terminal type `ATASCII` when set to an Atari mode. In SyncTERM that means setting the directory entry's **Screen Mode** to `Atari` (40x24) or `Atari XEP80` (80x25).
* **The port says so.** Give terminal programs on real hardware their own port with an [additional Telnet listener](./telnet.md#additional-listeners):

```hjson
{
  loginServers: {
    telnet: {
      listeners: {
        atari: {
          port: 6800
          emulation: atascii
        }
      }
    }
  }
}
```

Every caller on that port is treated as ATASCII, whatever its terminal announces. To send ATASCII callers down menus of their own, branch a connect menu on `TE[atascii]`; see [Flow Control](../../configuration/menu-hjson.md#flow-control).

### What is translated

* **Text** is mapped to ATASCII. Box drawing characters become ATASCII's line graphics; block characters become ATASCII blocks, some through inverse video; a character with no equivalent becomes `?`.
* **No colour.** An Atari screen has one colour. Colours are dropped. Reverse video, and any background colour other than black, are shown as inverse characters. Bold and bright colours look the same as plain text.
* **Cursor movement.** ATASCII has no "go to row, column" and no "home": only a screen clear puts the cursor in a known place. ENiGMA½ tracks the cursor and sends relative moves.
* **Screen size** is what the terminal reports, otherwise 40x24, up to 160x100.
* Nothing is asked of the terminal at connect, so there is no feature detection pause.

### Keys

The decoder accepts what SyncTERM, IcyTerm and a real Atari each send for Return, Backspace, Tab, Escape and the cursor keys. An Atari keyboard has no Home, End or Page keys, so three Ctrl combinations stand in:

| Key | Acts as |
|-----|---------|
| CTRL W | Page Up |
| CTRL Z | Page Down |
| CTRL X | End |

The message editor already has CTRL A and CTRL E for the start and end of a line.

Escape is also the prefix IcyTerm puts before cursor keys, so ENiGMA½ waits a tenth of a second after an Escape to see which it is.

### Limits

* **Focus may be invisible.** With one colour, a menu item that a theme highlights only with a brighter colour looks the same focused or not. Themes that highlight with a background colour, or with a different text style, show focus correctly. A theme for ATASCII callers (`info.emulation: atascii`) should use reverse video for focus.
* The stock menus and art are laid out for 80 column ANSI. Expect wrapped art.
* Four characters cannot be typed from a PC keyboard in an Atari mode, because ATASCII has no such characters: `` ` ``, `{`, `}` and `~`. A typed `~` arrives as Backspace.
* After a door or a file transfer, the cursor position is unknown, and there is no way to find it again short of clearing the screen. The next menu normally clears; until then, output that needs a position clears the screen first.
* The bottom right screen cell is never drawn, because writing it scrolls an Atari screen.
* The four arrow characters are shown as `^`, `v`, `<` and `>`. ATASCII has real arrow glyphs, but they can only be drawn with its escape prefix, and SyncTERM draws those five prefixed glyphs as other characters.
* Doors expect an ANSI terminal; their output is translated but their input is not. Use the `TE` [ACS](../../configuration/acs.md) code to keep doors away from ATASCII callers, for example `TE[ansi]` on a door menu entry.
* File transfers, and bridged connections such as the Telnet bridge and door networks, are passed through untranslated in both directions.
* The screen size is settled at connect. If the terminal reports a different size later, ENiGMA½'s views use it but the ATASCII translation does not, and the screen will go wrong until the caller reconnects. Atari modes in SyncTERM and IcyTerm have a fixed size, so this only matters to other clients.

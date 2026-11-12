---
title: ATASCII (Atari) Callers
description: "How ENiGMA½ serves Atari 8-bit style terminals: detection, a dedicated port, what is translated, keys, and current limits."
sidebar:
    order: 6
---
## ATASCII

ENiGMA½ can serve Atari 8-bit style terminals that speak ATASCII in place of ANSI: SyncTERM and IcyTerm in their Atari modes, and terminal programs on real Atari hardware.

This is early support, earlier than [PETSCII](./petscii.md). The board is still ANSI inside: menus, prompts and views are translated on the way out. Art can be native ATASCII (`.ata` files, see [Native ATASCII art](#native-atascii-art)), but there is no starter menu tree or theme yet, so on a board without ATASCII art an ATASCII caller sees your existing menus and art, translated, in one colour, wrapped at 40 columns. Nothing changes for ANSI callers.

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

### Native ATASCII art

Art drawn with an ATASCII editor, or taken from an Atari BBS, can be shown to ATASCII callers as it is. Save it as an `.ata` file (the raw ATASCII bytes an Atari terminal would be sent, with no header) under the same name as the ANSI piece it replaces, in a theme for ATASCII callers:

```
art/themes/my_atari_theme/theme.hjson     info: { name: "My Atari Theme", emulation: atascii }
art/themes/my_atari_theme/MATRIX.ata
art/themes/my_atari_theme/LOGIN.ata
```

and give ATASCII callers that theme in `config.hjson`:

```hjson
theme: {
    emulations: {
        atascii: {
            default: my_atari_theme
            preLogin: my_atari_theme
        }
    }
}
```

:::caution[A partial ATASCII theme strands callers]
Once an ATASCII theme is in use, an ATASCII caller's art is looked for in that theme and in `art/general` only: the ANSI theme is not consulted, and nothing is translated from it. A theme with art for only some menus leaves the caller on blank screens at the first menu it has no art for. Until ENiGMA½ ships starter menus for ATASCII callers, give such a theme art for every menu its callers can reach, or keep ATASCII callers on the translated ANSI theme.
:::

* **Making it.** [Icy Draw](https://github.com/mkrueger/icy_tools) draws ATASCII screens and saves them as `.ata`. It saves an 80 column (XEP80) screen as `.xep`: the bytes are the same, so rename the file to `.ata`; ENiGMA½ looks only for `.ata`.
* **Selection.** An ATASCII caller is given `NAME.ata` in preference to any other file called `NAME` in the same place, with the usual random selection (`NAME1.ata`, `NAME2.ata`, ...). The search still goes one place at a time (theme, then default theme, then `art/general`), so a `NAME.ans` in the caller's theme is used before a `NAME.ata` in the default theme: keep an ATASCII theme's art in that theme. Where a place has no `NAME.ata`, its ANSI art is translated, as before.
* **Only ATASCII callers get `.ata` art.** An `.ata` file sitting beside `.ans` or `.seq` files changes nothing for ANSI or PETSCII callers, and an ATASCII caller is never given a `.seq`. Art named with its extension (`art: MATRIX.ata`) shown to another caller anyway is shown as plain text: the characters and the line ends, without inverse video or cursor movement, never as ATASCII bytes.
* **The bytes go out as they are.** Inverse video, cursor movement, CLEAR, tabs and the insert and delete codes in the file all work as on an Atari, and ENiGMA½ follows them so that views drawn afterwards land in the right place. Art is not paged (`pause: pageBreak` shows it whole), and no ANSI preparation is applied to it. Start each screen with CLEAR (0x7D), or let the menu clear the screen first (`cls: true`): ATASCII has no other way to put the cursor in a known place, so if the position is not known when the art starts (after a door or a file transfer) and the art does not begin with CLEAR, ENiGMA½ sends one first.
* **Screen size.** Draw for 40x24: SyncTERM's `Atari` mode, IcyTerm and a real Atari. An 80x25 XEP80 screen (SyncTERM's `Atari XEP80` mode) is the same format, for callers whose terminal is 80 columns wide. There is one `.ata` per name, shown at whatever width the caller has, so art drawn for 80 columns wraps on a 40 column screen. Writing a character in the last column wraps to the next row at once, so a full-width row needs no END OF LINE (Icy Draw saves full rows without one). Writing the bottom row's last cell scrolls the whole screen up a line: leave that cell empty. An END OF LINE at the very end of the file is dropped when it would scroll.
* **Inverse video.** An Atari screen has no colour. Each character is normal or inverse (bit 7 of its byte). A view takes the inverse video of the place its MCI code was typed.
* **MCI codes** are typed into the art as ordinary characters, as in ANSI art: `%TL1`, `%ET2`, `%VM1`, and so on (see [MCI Codes](../../art/mci.md)), in upper or lower case (`%tl1` is `%TL1`). A code may be typed in inverse video, for example inside an inverse bar: the view is then drawn in inverse, and the code's cells are blanked with inverse spaces, so the bar stays whole. Whether a code is inverse is taken from its `%`. A code is one unbroken run of characters: a cursor movement or END OF LINE inside it means it is not a code.
* **Cursor movement at the edges.** On a real Atari and in SyncTERM, the cursor codes wrap to the opposite edge of the screen (UP on the top row goes to the bottom row); IcyTerm stops at the edge. ENiGMA½ follows the Atari, so art that moves the cursor across an edge looks different in IcyTerm, and views placed after it are out of place there: do not rely on it. In the same way, TAB uses the Atari's default stops (every 8 columns) and any the art sets or clears itself, but a caller can change the stops in their own terminal; and DELETE LINE and INSERT LINE are taken to leave the cursor in the first column, as SyncTERM does. Avoid tabs ahead of MCI codes.
* **Escaped characters.** The arrows, the escape symbol, the clear screen arrow and the two triangles share their bytes with control codes; an Atari draws them when the byte follows ESC (0x1B). They go out as they are. SyncTERM draws five of them wrongly (ESC followed by 0x1B to 0x1F, the escape symbol and the four arrows, and their inverse forms, come out as `[`, `\`, `]`, `^` and `_`); IcyTerm and a real Atari draw them correctly. Text that ENiGMA½ itself writes avoids them, but native art is not changed: if your callers use SyncTERM, draw arrows another way. ESC before END OF LINE (0x9B) is still a line end, so the inverse escape symbol cannot be drawn. An ESC as the last byte of the file is dropped.
* **SAUCE.** Icy Draw can add a SAUCE record to the file; it is removed (with its comment block and the end-of-file byte in front of it) and not shown. Its width is used only for the plain text other callers get. Byte 0x1A is a line drawing character in ATASCII, not an end-of-file marker, so 0x1A bytes at the end of a file without SAUCE are shown: a file that has been through an XMODEM transfer may end in a run of them as padding, drawn as corners; remove it.

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

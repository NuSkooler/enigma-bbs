---
title: PETSCII (Commodore) Callers
description: "How ENiGMA½ serves Commodore 64 and 128 style terminals: detection, a dedicated port, native PETSCII (.seq) art, what is translated, and current limits."
sidebar:
    order: 5
---
## PETSCII

ENiGMA½ can serve Commodore-style terminals that speak PETSCII in place of ANSI: SyncTERM and IcyTerm in their C64 or C128 modes, and terminal programs on real Commodore hardware.

This is early support. The board is still ANSI inside: menus, prompts and views are translated on the way out. Art can be native PETSCII (`.seq` files, see [Native PETSCII art](#native-petscii-art)); where a piece has no PETSCII version, the ANSI art is translated, and art drawn for an 80 column ANSI screen does not look right on a 40 column PETSCII one. Nothing changes for ANSI callers.

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

### Native PETSCII art

Art made with a PETSCII editor, or taken from a Commodore BBS, can be shown to PETSCII callers as it is. Save it as a `.seq` file (a Commodore sequential file: the raw PETSCII bytes, as PETSCII editors export them) under the same name as the ANSI piece it replaces, in a theme for PETSCII callers:

```
art/themes/my_c64_theme/theme.hjson     info: { name: "My C64 Theme", emulation: petscii }
art/themes/my_c64_theme/MATRIX.seq
art/themes/my_c64_theme/LOGIN.seq
```

* **Selection.** A PETSCII caller is given `NAME.seq` in preference to any other file called `NAME`, through the usual search (theme, default theme, `art/general`) and random selection (`NAME1.seq`, `NAME2.seq`, ...). Where a name has no `.seq` file, the caller gets the ANSI art translated, as before: something rather than a blank screen. Making the art is up to you; the stock ANSI art is not designed for 40 columns.
* **ANSI callers never get `.seq` art.** A `.seq` file sitting beside `.ans` files changes nothing for them, even in a theme they use. Art named with its extension (`art: MATRIX.seq`) shown to an ANSI caller anyway is shown as plain text, never as PETSCII bytes.
* **The bytes go out as they are.** Colours, reverse video, cursor movement, HOME and CLR in the file all work as on a Commodore. ENiGMA½ follows them so that views drawn afterwards land in the right place. Art is not paged (`pause: pageBreak` shows it whole), and no ANSI preparation is applied to it.
* **Screen size.** Draw for 40x25 (C64) unless you know your callers use 80 columns. The Commodore screen wraps to the next row as soon as the last column is written, and writing the bottom row's last cell scrolls the screen; a RETURN at the very end of the file is dropped when it would scroll.
* **Character set.** A Commodore screen shows one of two character sets at a time: lower/upper case (ENiGMA½'s default) or upper case and graphics. A `.seq` file is drawn in lower/upper unless it says otherwise, either with its own set switch byte (0x0E lower/upper, 0x8E upper/graphics) or through the art's `encodedAs` option, set in the menu's or the theme's `config`:

  | `encodedAs` | Character set |
  |---|---|
  | `petscii` or `petscii_lower` (default) | lower/upper case |
  | `petscii_upper` | upper case and graphics |

  The set applies to the whole screen, so art drawn in upper/graphics keeps it until the next clear screen; text ENiGMA½ writes over it in the meantime is shown in capitals. The clear switches back to lower/upper. A menu that uses `encodedAs: petscii_upper` and falls back to an ANSI file ignores the setting.
* **MCI codes** are typed into the art as ordinary characters, as in ANSI art: `%TL1`, `%ET2`, `%VM1`, and so on (see [MCI Codes](../../art/mci.md)). The letters may be typed shifted or not; in the lower/upper set either way works, `%tl1` is `%TL1`. In upper/graphics, type them unshifted (shifted letters are graphics there). A view takes the colour and reverse video in effect where its code was typed. PETSCII has no background colour.
* **SAUCE** is not expected in `.seq` files; if one is present it is removed and not shown. Trailing 0x1A bytes (the padding an XMODEM transfer adds) are removed too.

### What is translated

* **Text** is mapped to PETSCII's lower and upper case character set. Box and block drawing characters become the nearest PETSCII graphics; a character with no equivalent becomes `?`.
* **Colour.** The 16 ANSI foreground colours map to the 16 Commodore colours. PETSCII has no background colour, so a background is shown as reverse video in that colour.
* **Cursor movement.** PETSCII has no "go to row, column". ENiGMA½ tracks the cursor and sends relative moves.
* **Screen size** is what the terminal reports, otherwise 40x25.
* **Keys.** Cursor keys, HOME, INST/DEL (backspace), RETURN and F1 to F8 work as their ANSI equivalents. CLR, which SyncTERM sends for the End key, is End.
* Nothing is asked of the terminal at connect, so there is no feature detection pause.

### Limits

* Menus and art are laid out for ANSI. Expect wrapped art on a 40 column screen until a theme is made for it, with `.seq` art. A theme declares `emulation: petscii` in its `info` block to be used for these callers.
* A form is chosen by the MCI codes in its art: a 40 column screen that leaves a view out needs a matching form in the theme.
* Art that is not shown through a menu or prompt (achievement and node message headers and footers, for example) uses the ANSI art, translated, or plain text from a `.seq` file named with its extension.
* No hyperlinks, fonts, blink or underline.
* The bottom right screen cell is never drawn, because writing it scrolls a Commodore screen.
* Some control key combinations do not exist on a Commodore keyboard: Ctrl with E, N, Q, R, S or T share their codes with colour, cursor and delete keys.
* Doors expect an ANSI terminal. A door's output is translated like any other output, but its input is not: the door receives PETSCII key codes, so cursor and function keys will not work in it, and most doors assume 80 columns. Use the `TE` [ACS](../../configuration/acs.md) code to keep doors away from PETSCII callers, for example `TE[ansi]` on a door menu entry.
* File transfers, and bridged connections such as the Telnet bridge and door networks, are passed through untranslated in both directions.
* A window resize during a session is not followed; the size is settled at connect, up to 160x100.

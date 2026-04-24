---
layout: page
title: General Art Information
---
## General Art Information
One of the most basic elements of BBS customization is through its artwork. ENiGMA½ supports a variety of ways to select, display, and manage art.

### Art File Locations
As a general rule, art files live in one of two places:

1. The `art/general` directory. This is where you place common/non-themed art files.
2. Within a _theme_ such as `art/themes/super_fancy_theme`.

### MCI Codes
All art can contain [MCI Codes](mci.md).

### Art in Menus
While art can be displayed programmatically such as from a custom module, the most basic and common form is via `menu.hjson` entries. This usually falls into one of two forms:

#### Standard
A "standard" entry where a single `art` spec is utilized:
```hjson
{
    mainMenu: {
        art: main_menu.ans
    }
}
```

#### Module Specific / Multiple Art
An entry for a custom module where multiple pieces are declared and used. The second style usually takes the form of a `config.art` block with two or more entries:
```hjson
{
    nodeMessage: {
        config: {
            art: {
                header: node_msg_header
                footer: node_msg_footer
            }
        }
    }
}
```

A menu entry has a few elements that control how art is selected and displayed. First, the `art` *spec* tells the system how to look for the art asset. Second, the `config` block can further control aspects of lookup and display. The following table describes such entries:

| Item | Description|
|------|------------|
| `font` | Sets the [SyncTERM](http://syncterm.bbsdev.net/) style font to use when displaying this art. If unset, the system will use the art's embedded [SAUCE](http://www.acid.org/info/sauce/sauce.htm) record if present or simply use the current font. See Fonts below. |
| `pause` | Pause after displaying. `true` or `'end'` pauses at the end; `'pageBreak'` paginates the art screen-by-screen; a prompt name string uses that prompt in end mode. See [Pause Prompts](pause-prompts.md). |
| `baudRate` | Throttle art display to simulate a modem connection at the given baud rate. Works with all terminal clients. See [Baud Rates](#baud-rates) below. |
| `cls` | Clear the screen before display if set to `true`. |
| `random` | Set to `false` to explicitly disable random lookup. |
| `types` | An optional array of types (aka file extensions) to consider for lookup. For example : `[ '.ans', '.asc' ]` |
| `readSauce` | May be set to `false` if you need to explicitly disable SAUCE support. |

#### Art Spec
In the section above it is mentioned that the `art` member is a *spec*. The value of a `art` spec controls how the system looks for an asset. The following forms are supported:

* `FOO`: The system will look for `FOO.ANS`, `FOO.ASC`, `FOO.TXT`, etc. using the default search path. Unless otherwise specified if `FOO1.ANS`, `FOO2.ANS`, and so on exist, a random selection will be made.
* `FOO.ANS`: By specifying an extension, only the exact match will be searched for.
* `rel/path/to/BAR.ANS`: Only match a path (relative to the system's `art` directory).
* `/path/to/BAZ.ANS`: Exact path only.

ENiGMA½ uses a fallback system for art selection. When a menu entry calls for a piece of art, the following search is made:

1. If a direct or relative path is supplied, look there first.
2. In the users current theme directory.
3. In the system default theme directory.
4. In the `art/general` directory.

#### UTF-8 Art Variants

For UTF-8 capable terminals ENiGMA½ will automatically prefer a `.utf8ans` file over a `.ans` file when both share the same base name. This lets you ship two versions of any art piece side-by-side:

```
art/general/MATRIX.ANS       ← served to CP437 / legacy terminals
art/general/MATRIX.UTF8ANS   ← served to UTF-8 terminals (xterm, iTerm2, etc.)
```

No configuration change is required in `menu.hjson` — simply place the `.utf8ans` file alongside the `.ans` file using the same base name and the correct version is selected automatically. If no `.utf8ans` file exists the system falls back to `.ans` (or any other supported type) transparently.

`.utf8ans` files are decoded as UTF-8 and may contain any Unicode content: CJK characters, emoji, Unicode box-drawing, etc. They otherwise follow the same rules as standard ANSI art files including SAUCE metadata, MCI codes, and `pause` / `baudRate` config options.

> :information_source: The terminal encoding is negotiated during connect via the ANSI CPR-based probe. To additionally enable UTF-8 detection for terminals that self-identify as CP437 types, set `term.probeUtf8Encoding: true` in `config.hjson`.

#### ACS-Driven Conditionals
The [ACS](../configuration/acs.md) system can be used to make conditional art selection choices. To do this, provide an array of possible values in your art spec. As an example:
```hjson
{
    fancyMenu: {
        art: [
            {
                acs: GM[l33t]
                art: leet_art.ans
            }
            {
                //  default
                art: newb.asc
            }
        ]
    }
}
```

#### SyncTERM Style Fonts
ENiGMA½ can set a [SyncTERM](http://syncterm.bbsdev.net/) style font for art display. This is supported by many other popular BBS terminals as well. A common usage is for displaying Amiga style fonts for example. The system will use the `font` specifier or look for a font declared in an artworks SAUCE record (unless `readSauce` is `false`).

The most common fonts are probably as follows:

* `cp437`
* `c64_upper`
* `c64_lower`
* `c128_upper`
* `c128_lower`
* `atari`
* `pot_noodle`
* `mo_soul`
* `microknight_plus`
* `topaz_plus`
* `microknight`
* `topaz`

...and some examples:

 ![cp437](../assets/images/cp437.png "cp437")<br>
 ![pot_noodle](../assets/images/pot_noodle.png "pot_noodle")<br>
 ![mo_soul](../assets/images/mo_soul.png "mo_soul")<br>
 ![microknight_plus](../assets/images/microknight_plus.png "microknight_plus")<br>
 ![topaz_plus](../assets/images/topaz_plus.png "topaz_plus")<br>
 ![microknight](../assets/images/microknight.png "microknight")<br>
 ![topaz](../assets/images/topaz.png "topaz")<br>

Other "fonts" also available:
* `cp1251`
* `koi8_r`
* `iso8859_2`
* `iso8859_4`
* `cp866`
* `iso8859_9`
* `haik8`
* `iso8859_8`
* `koi8_u`
* `iso8859_15`
* `iso8859_4`
* `koi8_r_b`
* `iso8859_4`
* `iso8859_5`
* `ARMSCII_8`
* `iso8859_15`
* `cp850`
* `cp850`
* `cp885`
* `cp1251`
* `iso8859_7`
* `koi8-r_c`
* `iso8859_4`
* `iso8859_1`
* `cp866`
* `cp437`
* `cp866`
* `cp885`
* `cp866_u`
* `iso8859_1`
* `cp1131`

> :information_source: See [this specification](https://github.com/protomouse/synchronet/blob/master/src/conio/cterm.txt) for more information.

#### Baud Rates
The `baudRate` member throttles art display on the server side, dripping bytes to the terminal at the rate a real modem of that speed would have delivered them. This works with every terminal client — no special support required. The rate applies only while the art is displaying and resets automatically when it finishes.

Accepted values: `300`, `600`, `1200`, `2400`, `4800`, `9600`, `19200`, `38400`, `57600`, `76800`, `115200`. A value of `unlimited`, `off`, or `0` disables throttling (immediate display).

The table below maps each rate to the modem era it evokes:

| Rate | Era | Representative Hardware |
|------|-----|------------------------|
| `300` | Late 1970s – early 1980s | Acoustic couplers; Bell 103; Novation CAT |
| `1200` | 1982 – 1986 | Hayes Smartmodem 1200; Bell 212A |
| `2400` | 1986 – 1991 | Hayes Smartmodem 2400; USR Courier 2400 |
| `4800` | 1989 – 1993 | USR Courier HST (early) |
| `9600` | 1990 – 1994 | USR Courier HST 9600; ZyXEL U-1496 |
| `19200` | 1992 – 1994 | USR Dual Standard; early V.32bis modems |
| `38400` | 1993 – 1996 | USR Sportster 14400; SupraFAXModem 14.4 |
| `57600` | 1994 – 1997 | USR Courier V.Everything (28.8k); SupraFAXModem 28.8 |
| `76800` | 1996 – 1998 | USR Courier 33.6; Rockwell V.34+ chipsets |
| `115200` | 1997 – 2000 | USR Courier 56K; Hayes Accura 56K; 3Com 56K |

### Common Example
```hjson
fullLogoffSequenceRandomBoardAd: {
    art: OTHRBBS
    desc: Logging Off
    next: logoff
    config: {
        baudRate: 57600
        pause: true
        cls: true
    }
}
```

### See Also
See also the [Show Art Module](../modding/show-art.md) for more advanced art display!
---
title: RIP (RIPscrip) Callers
description: "How ENiGMA½ serves RIPscrip terminals: detection, .rip art with clickable buttons, what is filtered, and what to know when drawing for SyncTERM and IcyTerm."
sidebar:
    order: 7
---
## RIP

RIPscrip ("RIP") is a graphics language for BBS terminals: lines, shapes, text and clickable buttons drawn on a 640x350 screen, mixed with ordinary ANSI text. SyncTERM and IcyTerm both draw it.

For ENiGMA½, RIP is an addition to ANSI, not a replacement for it. A RIP caller is an ANSI caller in every other respect: the same menus, prompts, views, themes and doors. There are three differences:

* **Art.** Where a theme has a `.rip` file beside the ANSI art of the same name, a RIP caller is shown the `.rip` file. See [RIP art](#rip-art).
* **Filtering.** Everything else ENiGMA½ sends a RIP caller is made inert to RIP first, so that text written by other people cannot run RIP commands on the caller's terminal. See [What is filtered](#what-is-filtered).
* **Routing.** The `TE[rip]` [ACS](../../configuration/acs.md) code matches RIP callers, for menus or menu entries of their own. See [Menus for RIP callers](#menus-for-rip-callers).

ENiGMA½ comes with a small set of [starter menus](#starter-menus) for RIP callers: three screens of buttons in front of the board's usual menus, offered by `oputil.js config new`. Without them, and until you add `.rip` files of your own, a RIP caller sees the board as an ANSI caller does, on a taller screen (see [Screen size](#screen-size)). Nothing changes for callers whose terminals do not draw RIP.

### How a caller gets RIP

There is nothing to configure. A session is RIP in either of two ways:

* **The terminal answers the RIP version query.** At connect, ENiGMA½ sends every ANSI session the RIPscrip version query along with its other connect-time questions. A RIP terminal answers with its version, for example `RIPSCRIP015410` (RIPscrip 1.54). The answer is taken out of the caller's input, so it never reaches a menu as keys. Other terminals do not answer and show nothing of the query. SyncTERM answers only when RIP is enabled for the directory entry.
* **The terminal type says so.** IcyTerm in RIP mode sends the Telnet terminal type `RIP`.

The log records each RIP session at info level as `Terminal emulation layer "rip" attached`, with how it was found (`probe`, `termType` or `listener`). The version the terminal reports is logged too.

PETSCII and ATASCII sessions are never sent the query and are never RIP.

An [additional Telnet listener](./telnet.md#additional-listeners) with `emulation: rip` makes every caller on its port a RIP caller, whatever the terminal says. A caller there whose terminal does not draw RIP is sent RIP all the same.

### Terminals

* **SyncTERM:** edit the directory entry and set its RIP option to `RIPv1`. With RIP off, SyncTERM does not answer the query and the session is plain ANSI. SyncTERM 1.10a and 1.10b stop sending keys and button clicks after either of two RIP commands; see [Commands to avoid](#commands-to-avoid).
* **IcyTerm:** choose the RIP emulation for the entry. Use a current build: older builds draw RIP buttons but do not register clicks on them correctly.

### RIP art

A `.rip` file is a RIPscrip script: RIP command lines, each starting with `!|`, mixed with ANSI text. Save it under the same name as the ANSI piece it replaces, in the same directory:

```
art/themes/luciano_blocktronics/MMENU.ANS     ANSI callers
art/themes/luciano_blocktronics/MMENU.rip     RIP callers
```

* **Selection.** A RIP caller asked for art `NAME` is given `NAME.rip` in preference to any other file called `NAME` in the same directory, with the usual random selection (`NAME1.rip`, `NAME2.rip`, ...). The extension may be upper or lower case. Where there is no `.rip`, the caller gets what an ANSI caller would.
* **Same directory.** The search still goes one directory at a time (the caller's theme, then the default theme, then `art/general`), and the first directory holding any file for the name wins. A `NAME.ans` in the caller's theme is used before a `NAME.rip` in `art/general`, so keep each `.rip` beside the `.ans` it replaces.
* **Other callers never get `.rip` art** found by name. A `.rip` file beside `.ans` files changes nothing for ANSI, PETSCII or ATASCII callers. A menu that names one outright (`art: MMENU.rip`) shows it to them as text.
* **Trusted.** A `.rip` file is yours, like any file you install: its RIP commands go to the terminal as they are, unfiltered. Only art that a menu, prompt or theme names is shown as RIP. An art name holding a path, and art the [Show Art module](../../modules/show-art.md) takes from `extraArgs`, are never shown as RIP: such a file is shown as text, filtered.
* **Text and MCI codes.** A RIP command line at the start of a line takes no room on the screen. ENiGMA½ counts the ANSI text around such lines as the terminal draws it, so [MCI codes](../../art/mci.md) in the text place their views where they should. MCI codes inside a command line are not looked for. The values views put on screen (a user name, say) are drawn by ENiGMA½ after the art, and are filtered like the rest of its output.
* **Line ends.** Use CR LF, as in ANSI art. A bare LF is sent as CR LF.
* **Baud emulation.** [`baudRate`](../../art/general.md#baud-rates) works for `.rip` art as for any other.
* **Not paged.** `pause: pageBreak` shows a `.rip` file whole: RIP draws by its own coordinates.
* **Encoding.** A `.rip` file is read as CP437, like `.ans`, unless the art's `encodedAs` says otherwise.

### Leaving a RIP screen

Clearing the screen removes RIP drawing but not its buttons and click regions: on SyncTERM and IcyTerm they stay live, invisible and clickable. When a caller who was shown a `.rip` moves to another menu, ENiGMA½ sends RIP's "kill mouse fields" command (`!|1K`) before the next menu draws anything.

This happens on a menu change only. A screen redrawn inside the same menu (a help screen, or a prompt or pause with `.rip` art of its own) leaves the earlier buttons live until the caller leaves the menu. Draw buttons only where every one of them makes sense for as long as the caller stays in that menu.

### Drawing for RIP terminals

RIP terminals differ more than ANSI terminals do. The advice below holds for SyncTERM and IcyTerm; test your art on both.

#### Set the font style first

Make `!|Y00000100` the first command of every `.rip` file: the default 8x8 font, horizontal, size 1. Terminals differ in their default size, and without it IcyTerm draws button labels far too large.

#### Screen size

RIP mode is 80 columns by about 43 rows, and terminals report 42 to 44. ENiGMA½ uses what the session reports, so lay out text and views for that, not for a fixed 43. ANSI art drawn for 25 rows fills only the top part of the screen.

RIP coordinates are pixels on a 640x350 screen, from 0,0 at the top left. With the 8x8 font a text cell is 8 pixels square: text column *c* starts at x = (*c* - 1) x 8 and row *r* at y = (*r* - 1) x 8. Use that to keep buttons clear of the text and views around them.

#### One command per line

On some terminals a RIP command runs only at the start of a line, so put each command on a line of its own, starting in the first column.

Only command lines that start a line take no room. A command elsewhere is counted as text, and commands that move the text (text windows and viewports) leave ENiGMA½ counting positions the terminal no longer uses: MCI codes after them land in the wrong place.

#### Buttons send the menu's own keys

A RIP button sends text to the board when clicked, as if the caller had typed it. Have it send what the caller would type in that menu: on a menu whose `menuCommand` prompt takes `M` and Enter, a button whose host command is `M^M`. `^M` is Enter; it arrives as CR or as CR LF, depending on the terminal.

Do not rely on:

* **Button hotkeys.** RIP lets a button name a key that presses it. SyncTERM 1.10 and IcyTerm ignore them: the key arrives as an ordinary key. Give every button a hotkey of `00` (none) and let the menu's own keys do the work.
* **Text windows.** Terminals disagree on where text goes inside one.
* **Turning RIP off and on.** SyncTERM cannot turn RIP back on during a call once it is off.

#### Commands to avoid

Do not use `!|*` (reset windows) or `!|w` (text window) in a `.rip` file. After either one, SyncTERM 1.10a and 1.10b stop sending the caller's keys and button clicks for the rest of the call. ENiGMA½ never sends either itself.

### Example: a main menu

This `.rip` draws three buttons for the stock main menu (`mainMenu`, art `MMENU`), with ANSI text around them and an MCI code. Saved as `MMENU.rip` beside `MMENU.ANS` in your theme, it is shown to RIP callers in place of the ANSI main menu. `ESC` stands for the escape byte (0x1B), as in any ANSI art; the ten empty lines move the text cursor below the buttons, where the menu's prompt is drawn.

```text
!|Y00000100
!|1B00000200ZM0000080F080700000E07000000
!|1U0K1C3C280000<>Messages<>M^M
!|1U3W1C6O280000<>Who<>W^M
!|1U781CA0280000<>Goodbye<>G^M
ESC[0;1;36m Main menu
ESC[0;36m Click a button, or type its letter and press Enter.










ESC[0;33m Logged in as %UN
```

The menu needs nothing new. Here is the stock entry, shortened to the three commands the buttons send:

```hjson
mainMenu: {
    desc: Main Menu
    art: MMENU
    prompt: menuCommand
    submit: [
        {
            value: {
                command: "M"
            }
            action: @menu:messageBaseMainMenu
        }
        {
            value: {
                command: "W"
            }
            action: @menu:mainMenuWhosOnline
        }
        {
            value: {
                command: "G"
            }
            action: @menu:fullLogoffSequence
        }
    ]
}
```

The `menuCommand` prompt's text field takes the letter, and Enter submits it, whether the caller typed it or clicked a button.

To write the file from a bash shell, with CR LF line ends:

```bash
printf '%s\r\n' \
  '!|Y00000100' \
  '!|1B00000200ZM0000080F080700000E07000000' \
  '!|1U0K1C3C280000<>Messages<>M^M' \
  '!|1U3W1C6O280000<>Who<>W^M' \
  '!|1U781CA0280000<>Goodbye<>G^M' \
  $'\e[0;1;36m Main menu' \
  $'\e[0;36m Click a button, or type its letter and press Enter.' \
  '' '' '' '' '' '' '' '' '' '' \
  $'\e[0;33m Logged in as %UN' > MMENU.rip
```

#### Reading the commands

Numbers in RIP commands are "meganums": base 36, written with the digits `0` to `9` and then `A` to `Z` (`A` is 10, `Z` is 35), most often two digits wide. `1C` is 1 x 36 + 12 = 48. Colours are the 16 EGA colours, `00` to `0F`.

**`!|Y00000100`**, font style:

| Field | Value | Meaning |
|---|---|---|
| font | `00` | the default 8x8 font |
| direction | `00` | horizontal |
| size | `01` | normal size |
| reserved | `00` | |

**`!|1B00000200ZM0000080F080700000E07000000`**, button style, used by every button after it:

| Field | Value | Meaning |
|---|---|---|
| width, height | `00` `00` | 0: each button gives its own size |
| orientation | `02` | label in the centre of the button |
| flags | `00ZM` | 1282 = 1024 (mouse button: clicking it sends its host command) + 256 (plain button: filled with the surface colour) + 2 (invertable: inverted when clicked, on a terminal that draws that) |
| bevel size | `00` | no bevel |
| label colour | `00` | black |
| drop shadow colour | `08` | dark grey, not used without the drop shadow flag |
| highlight, shadow | `0F` `08` | white and dark grey, for the 3D effects (none chosen here) |
| surface colour | `07` | light grey |
| group | `00` | no radio or check box group |
| flags 2 | `00` | none |
| underline colour | `0E` | yellow, for an underlined hotkey (none here) |
| corner colour | `07` | light grey |
| reserved | `000000` | |

**`!|1U0K1C3C280000<>Messages<>M^M`**, a button:

| Field | Value | Meaning |
|---|---|---|
| x0, y0 | `0K` `1C` | top left corner at pixel 20, 48 |
| x1, y1 | `3C` `28` | bottom right corner at pixel 120, 80 |
| hotkey | `00` | none (see above) |
| flags | `0` | drawn unselected |
| reserved | `0` | |
| text | `<>Messages<>M^M` | no icon, the label `Messages`, and the host command `M^M` |

The other two buttons are the same size, at x 140 to 240 (`3W` to `6O`) and 260 to 360 (`78` to `A0`). The buttons cover pixel rows 48 to 80, which are text rows 7 to 10, with the bottom edge on the first pixel row of row 11. The two text lines are rows 1 and 2, since the command lines take no room, and `%UN` is on row 13. In a label or host command, write `!`, `|` and `\` as `\!`, `\|` and `\\`.

### Menus for RIP callers

`.rip` art needs no menu changes: the menu stays the same, and RIP callers see the `.rip` file. To give RIP callers menus of their own, use the `TE[rip]` [ACS](../../configuration/acs.md) code in an ACS-conditional `next` or menu entry, as the [PETSCII](./petscii.md#an-existing-board) and [ATASCII](./atascii.md#an-existing-board) pages do for their callers. There is no configuration key for it. For example, in `telnetConnected`:

```hjson
next: [
    {
        acs: TE[rip]
        next: ripMatrix
    }
    {
        next: matrix
    }
]
```

where `ripMatrix` is the [starter menus'](#starter-menus) login matrix, or a menu of your own. A RIP caller also matches `TE[ansi]`, so put a `TE[rip]` entry ahead of any `TE[ansi]` one.

RIP callers use ANSI themes: RIP is not a theme emulation, and `theme.emulations` has no `rip` entry.

### Starter menus

ENiGMA½ ships a small, separate set of menus for RIP callers: three screens of clickable buttons, drawn with RIP, in front of the board's usual menus.

* **Login matrix** (`ripMatrix`): Login, Apply, Log Off.
* **Main menu** (`ripMain`): Messages, Who's Online, Last Callers, Goodbye.
* **Messages** (`ripMessages`): List / Read, Post, Change Area, New Scan, Back.

Each button sends one letter, the one in brackets on its label, without Enter. The menu takes the same letter, so typing it does the same as clicking; RIP button hotkeys are not used (see [Buttons send the menu's own keys](#buttons-send-the-menus-own-keys)). Escape also goes back from the message menu.

Everything behind the buttons is your board's own: the login form, the new user application, the message list, reader and editor, the new scan, who's online, last callers and logging off are the stock menus, in ANSI, with your theme and its art. Each one comes back to the button screen it was started from, apart from logging off and the new user application (see below).

The menus are in `misc/menu_templates/rip.in.hjson`, every one named `rip...`. Three are copies of stock menus that differ only in where they go next: `ripLogin` and the two-factor (2FA/OTP) menus are the stock `login` and `loginTwoFactorAuthOTP`, going on to `ripMain` instead of the stock login sequence, which ends in the stock main menu. Being copies, they do not get your theme's customisations of the stock menus, which are by menu name; on the stock theme that is the width of the two login fields. `ripNewScan` is the stock new scan for the message base only (`skipFileBase`), with the stock new message list.

The art is three `.rip` files, `RMATRIX`, `RMAIN` and `RMSGMENU`, each with an `.ans` of the same name that shows the same choices as text, for a caller who reaches the menu without RIP or whose `.rip` file is missing. They go in the general art directory (`art/general` unless `paths.art` says otherwise), since RIP has no theme of its own; nothing else ENiGMA½ ships uses these names. They are generated by `dev_util/rip_art/build.js` from the descriptions in `screens.js` (the sources are in `misc/rip_starter/`), in the stock theme's colours: greens for the title and highlights, cyans for text and button labels, greys for frames. They fit a 42 row screen, follow the advice in [Drawing for RIP terminals](#drawing-for-rip-terminals), and use only RIP commands seen working on SyncTERM and IcyTerm: font style, colour, fill style, bar, rectangle, text, button style and button. Draw your own over them if you like: keep the file names, and each button's host command the menu's key for it.

The three button screens use queued interrupts, the default: a page, a node message or an achievement pop-up that arrives while the caller is on one of them waits in the queue, and is shown on arrival at the next menu the caller moves to. The stock main menu instead sets `interrupt: realtime`, which shows them at once. Add `interrupt: realtime` to a starter menu's `config` if you want that for RIP callers.

Not in the starter menus:

* **New users.** "Apply" is the stock new user application. It ends as it does on any board: an applicant who is let straight in goes on to the stock login sequence and main menu, and stays on the stock (ANSI) menus for the rest of that call; one who must wait for activation is logged off. From their next call they log in through `ripMatrix`.
* **The login sequence.** Logging in goes straight to `ripMain`: the stock welcome screen, last callers, who's online, oneliners, new scan offer and statistics are not shown.
* **Files and doors.** There are no RIP screens for them.

#### A new board

`oputil.js config new` asks, after the PETSCII and ATASCII questions:

```
Include starter menus and art for RIP (RIPscrip) callers? (y/N)
```

The answer defaults to no, which produces exactly what `config new` has always produced. On yes it also:

1. copies `rip.in.hjson` into `config/menus/` as `<board>-rip.hjson` and adds it to the main menu file's `includes`;
2. copies the files in `misc/rip_starter/` into the general art directory, leaving alone any file of the same name already there;
3. writes `<board>-login.hjson` with the `TE[rip]` branch on `telnetConnected` shown in [Menus for RIP callers](#menus-for-rip-callers), after the PETSCII and ATASCII branches if you asked for those too.

Nothing is added to `config.hjson`. If a step cannot be done (a `<board>-login.hjson` or `<board>-rip.hjson` already in the way, or art that cannot be copied), `config new` finishes the rest and then lists what is left, under "The RIP starter is not complete". The branch is only added when all six art files are in the art directory, copied or already there: a button menu without its art is blank and takes no keys. If the art cannot be installed, RIP callers get the standard menus, and the report says to copy the six files and add the branch yourself (see below). An existing `<board>-rip.hjson` is kept as it is; it must define `ripMatrix`, `ripMain` and the other RIP menus.

#### An existing board

Nothing is changed for you; the same three steps by hand, in this order:

1. Copy `misc/menu_templates/rip.in.hjson` to your menus directory (for example `config/menus/myboard-rip.hjson`) and add that file name to the `includes` list in your main menu file.
2. Copy the six files in `misc/rip_starter/` into your general art directory (`art/general` unless you set `paths.art`). Do this before the next step: a RIP caller sent to a button menu whose art is not there gets a blank screen that takes no keys, and is stuck.
3. Branch the connect menu, only once the art is in place: in `telnetConnected` (in `myboard-login.hjson` on a board made by `config new`), make `next` the list shown in [Menus for RIP callers](#menus-for-rip-callers), with `ripMatrix` as the menu for `TE[rip]`. A stock board has a single `next: matrix` there: replace that line with the whole list. If `next` is already a list (a board with the PETSCII or ATASCII starter), add the `TE[rip]` entry before the last entry and keep the others.

Then run `./oputil.js config validate`.

An [additional Telnet listener](./telnet.md#additional-listeners) with `emulation: rip` and no `firstMenu` sends its callers through `telnetConnected` too, so they take the same branch.

### What is filtered

A RIP terminal runs RIP commands wherever it finds them in what it is sent. Text written by other people (messages, user names, file descriptions, chat, oneliners) could otherwise draw over the screen, add invisible buttons, or make the terminal type input to the board as if the caller had. So for a RIP session, everything ENiGMA½ itself sends passes through a filter. To the text it is given, it makes three changes and no others:

* a NUL goes between `!` and a `|` straight after it. That stops the command and shows nothing.
* bytes 0x01 and 0x02 are shown as `*`. They are the CP437 smiley glyphs, and RIP terminals start a command at them too.
* RIP's own control sequences, `ESC[` digits `!` (which can turn RIP off, or make the terminal send its version as input), are removed.

Where filtered text follows unfiltered output (a door's, or `.rip` art) that left a RIP command unfinished, the filter first ends that command with a line break, so the text cannot become part of it.

Not filtered:

* `.rip` art, as described above, and ENiGMA½'s own version query.
* Door output. A door is a program you installed, and a RIP-aware door may draw RIP for a RIP caller. The [Z-Machine door](../../doors/zmachine.md) is the exception: ENiGMA½ runs those games itself, and their text is filtered like its own.
* Bridged systems (the telnet bridge, BBSLink, DoorParty, Goldmine, ArchaicNet): what the remote system sends reaches the caller as it was sent.
* File transfers.

MRC chat shows `:)` and `:D` as typed for a RIP caller, never as the smiley glyphs, whatever `SHOWSMILIES` is set to.

### Doors and drop files

A door's output reaches a RIP caller unfiltered, the Z-Machine door's excepted (see above). In [BBSDEV.DRP](../../doors/scripts-and-binaries.md#bbsdevdrp), line 9 (RIP) is `Y` for a RIP caller and `N` otherwise. The other drop file formats do not report RIP: DOOR.SYS has no field for it, and DOOR32.SYS gives emulation `1` (ANSI), as Synchronet does.

### Limits

* The [starter menus](#starter-menus) cover logging in, messages, who's online and last callers; anything more needs menus and art of your own.
* Buttons and click regions are cleared when the caller changes menu, not when a screen is redrawn inside a menu.
* Only command lines at the start of a line take no room; see [One command per line](#one-command-per-line).
* ENiGMA½ does not send RIP icon files, nor answer a terminal's requests for them. Draw buttons with commands, as in the example.

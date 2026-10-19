# Building an Amiga door image

ENiGMA½ boots each Amiga door from a hard-disk image file: a bare FFS
partition (no RDB) that the emulator mounts as the boot volume. The image needs
the shim, the door library, the startup sequence and the door itself. Until
`oputil` can write FFS images, use [amitools](https://github.com/cnvogelg/amitools)'
`xdftool` (`pip install amitools`).

## Script

`make_image.sh` does the recipe below for you, for one or more door directories:

```sh
python3 -m venv ~/amitools-venv && ~/amitools-venv/bin/pip install amitools
XDFTOOL=~/amitools-venv/bin/xdftool \
    misc/amiga_door/image/make_image.sh [-s 2000K] [-n BBS] [-w WB.adf] [-f] ~/amiga/doors.hdf ~/doors/dreamsweeper
```

Each door directory is copied, layout kept, to `Doors/<directory name>/` in the
image (here `BBS:Doors/dreamsweeper/...`). `-f` replaces an existing image.
`-w` adds ARexx from your Workbench 3.1 disk, for ARexx doors (see below).

## Recipe

From the ENiGMA½ checkout, for a door unpacked in `~/doors/dreamsweeper/`:

```sh
A=misc/amiga_door
IMG=~/amiga/dreamsweeper.hdf

xdftool "$IMG" create size=2000K + format BBS ffs \
    + makedir C + makedir S + makedir Libs + makedir Doors + makedir Doors/DreamSweeper \
    + write "$A/bin/axshim" C/axshim \
    + write "$A/bin/AEDoor.library" Libs/AEDoor.library \
    + write "$A/image/Startup-Sequence" S/Startup-Sequence \
    + write ~/doors/dreamsweeper/dreamsweeper.xim Doors/DreamSweeper/dreamsweeper.xim

xdftool "$IMG" list             # check what is on it
```

- `size=2000K` is the default and enough for most doors (the shim and library take
  about 90 KB, Workbench's ARexx files about 150 KB). **With a stock AROS ROM,
  keep the image at 2032K or less** (the largest 8 KB multiple under the
  4066-block limit). A bigger FFS volume needs a second bitmap block, and the
  stock AROS filesystem maps the blocks it covers wrongly: the first time a door
  writes, it can take blocks that hold other files (on a 4M image, Bad Libs' score
  file overwrote `rexxsyslib.library`'s header). `make_image.sh` warns. The ROM
  bundled with enigma-vamiga 0.1.2 and later carries the fix, and Kickstart 3.1's
  FastFileSystem handles any size. Every session carries the image, so keep it
  small anyway.
- Name the volume `BBS`. Doors find their files under `BBS:`; the shim also
  assigns `BBS:` to the boot volume, so another name works, but `BBS` keeps paths
  in door docs literal.
- The door's path inside the image is what ENiGMA's door config names, written
  with `BBS:` (for the example, `BBS:Doors/DreamSweeper/dreamsweeper.xim`).
- `xdftool` writes files with the current time and `rwed` protection, which is
  what doors expect.

## What else a door may need

Copy these from the door's archive, keeping its layout under `BBS:`:

- **Data and config files** the door reads or creates. Some doors refuse to create
  their data file and need an empty one to exist (for example Wallhall's
  `wALLhALL.dat`): `: > empty.dat` and `xdftool "$IMG" write empty.dat <path>`
  (`xdftool` skips `/dev/null` without a word).
- **Icons with tooltypes** (`<door>.info`, `BBS:Commands/BBSCmd/<cmd>.info`): /X
  doors often read their settings from their command icon.
- **Screens and bulletins** under `BBS:` paths the door displays (`JH_SF`/`JH_SG`).
- Files a door reads straight from /X's own data (`BBS:user.data`,
  `BBS:Node<n>/...`) are not emulated; such doors may not work.

Writes a door makes (high scores, walls, answers) land in the image; ENiGMA
writes the changed image back after a clean session.

## Paragon doors

A Paragon door (`doorType: tim`; Paragon, StarNet and MAX's BBS doors, /X's
`TYPE=TIM`) goes on the image like any other door, with its data directories
where its notes say (usually under `DOORS:`, which is `BBS:Doors`). What its
install notes put in the sysop's `S:Startup-Sequence` (an assign such as
`MSE:`, a variable in `ENV:`) goes in the door's ENiGMA config instead
(`assigns`, `env`): a minimal image has no `C:Assign`. `PGDOORS:` is assigned to
`SYS:Doors` by the shim. Doors built with HiSoft BASIC need `hisoftbasic.library`
or `hbasic2.library` (not freely available); without it they stop with an empty
requester and the session ends after `regTimeoutSeconds`.

## CLI doors

A CLI door (`doorType: cli`) goes on the image like any other door. Read its
documentation for:

- **Libraries.** Disk libraries the door opens must be in `Libs/`. The AROS ROM has
  `mathieeesingbas.library` but not `mathieeedoubbas`, `mathieeedoubtrans` or
  `mathieeesingtrans.library`, which every program compiled with DICE C opens at
  start-up (it quits silently, return code 0, without them). Take them from the AROS
  m68k boot ISO (`Libs/`, AROS Public License) on the
  [AROS nightly builds](https://sourceforge.net/projects/aros/files/nightly2/) page,
  or from your Workbench disks for a Kickstart image:

  ```sh
  xdftool "$IMG" write mathieeedoubbas.library Libs/mathieeedoubbas.library \
      + write mathieeedoubtrans.library Libs/mathieeedoubtrans.library \
      + write mathieeesingtrans.library Libs/mathieeesingtrans.library
  ```

- **Configuration files under `S:`** (Battle Grounds reads `S:BattleG.config`) and
  data directories the door will not create itself (Battle Grounds' `Users/`).
- **Assigns.** The shim makes `BBS:` (the boot volume) and `DOORS:` (`BBS:Doors`)
  only. A door that insists on another assign needs its files under one of those
  two, or a `C:Assign` and a line in the image's `S:Startup-Sequence`.

The command line is `doorArgs` in the door's menu entry; see the documentation
page for the placeholders.

## ARexx (AIM) doors

An ARexx door (`doorType: aim`, /X's `TYPE=AIM`) is a script, and running it
needs ARexx in the image. **ARexx doors need your own Workbench 3.1; AROS has no
ARexx.** Give `make_image.sh` your Workbench 3.1 disk image (an ADF of the
"Workbench3.1" disk) with `-w`:

```sh
XDFTOOL=~/amitools-venv/bin/xdftool \
    misc/amiga_door/image/make_image.sh -w ~/amiga/Workbench3.1.adf \
    ~/amiga/kickboxing.hdf ~/doors/Kickboxing
```

`-w` copies, from the same paths on the Workbench disk:

| Files | Why |
|---|---|
| `System/RexxMast` | the ARexx server; the image's `S:Startup-Sequence` starts it before the shim |
| `Libs/rexxsyslib.library`, `Libs/rexxsupport.library` | ARexx itself, and the support functions many scripts `ADDLIB` |
| `Libs/mathieeedoubbas.library`, `mathieeedoubtrans`, `mathieeesingtrans` | rexxsyslib will not start without `mathieeedoubbas`; neither the AROS ROM nor Kickstart 3.1 has it |
| `Rexxc/RX` and the rest of `Rexxc/` | the shim starts every script with `SYS:Rexxc/RX` |
| `C/Avail`, `Copy`, `Date`, `Delete`, `List`, `MakeDir`, `Rename`, `Type`, `Wait` | commands scripts run with `ADDRESS COMMAND` (Hacker runs `avail flush` after every move and ends with an error without it) |

These files are Commodore's (now Cloanto's), licensed with your Workbench: an
image built with `-w` is for your own board, do not pass it on. The same image
works with the bundled AROS ROM and with a Kickstart 3.1 ROM: Workbench 3.1's
ARexx runs on both.

Put the script where its documentation says, or anywhere: its own data paths
(`doors:Kickboxing/...`) are what matter, and the door config names the script
(`door: BBS:Doors/Kickboxing/KickBox.Rexx`). Scripts that `ADDLIB` a third-party
library need it in `Libs/` too, with the libraries it opens (The Death Game's
daily reset: `rexxarplib.library`, `screenshare.library`, `diskfont.library` and
`arp.library`).

Without `-w`, `doorType: aim` (and `cnetrexx`) sessions end at once with
`error=no rexxsyslib` (the ENiGMA log says so); XIM and CLI doors are not affected.

## C-Net ARexx doors

A C-Net ARexx door (`doorType: cnetrexx`, a C-Net Amiga "pfile" written in ARexx)
needs ARexx like an AIM door (`-w`), and lives where C-Net kept pfiles, under
`PFILES:`. Give each pfile's directory with `-p`, and any command its script runs
with `ADDRESS COMMAND` that Workbench does not have with `-c`:

```sh
XDFTOOL=~/amitools-venv/bin/xdftool \
    misc/amiga_door/image/make_image.sh -w ~/amiga/Workbench3.1.adf \
    -c ~/amiga/QSort/QSort -p ~/doors/Badlibs -p ~/doors/switchfont \
    ~/amiga/xdoors-cnet.hdf
```

`-p` copies the directory to `PFiles/<name>/` (Bad Libs' `HOMEDIR` is
`PFILES:BADLIBS/`; names are not case sensitive) and makes C-Net's mail tree
`CNet/Mail/Users`. At start-up the shim assigns `PFILES:` to `SYS:PFiles` and
`CNET:` to `SYS:CNet` when they exist, and each session makes the caller's
`CNET:Mail/Users/<account>/`, where pfiles keep per-caller files. A door that
wants another assign gets it from the door config's `assigns` (for example
`assigns: { PFILES: 'BBS:Doors/CNet' }` for a different layout).

The door config names the script: `door: PFILES:Badlibs/badlibs`.

- **Bad Libs** sorts its score lists with `QSort` (`address command 'qsort ... R'`):
  QSort 1.1 by Joerg Riemer, freeware with source, is on Aminet as
  [util/cli/QSort.lha](https://aminet.net/package/util/cli/QSort); put
  `QSort/QSort` from it in `C:` with `-c`. Workbench's `C:Sort` is not a
  substitute (no reverse order). Without it the script stops at its main screen
  with an ARexx error.
- Pfiles that `ADDLIB` `cnet.library` or `cnetc.library`, C pfiles (68k programs that
  read C-Net's own structures) and pfiles that read C-Net's data files
  (`bbs.udata`, its message base) do not run: there is no C-Net here.

## Startup-Sequence

`Startup-Sequence` here is the template: it sets `FailAt` and `Stack`, makes the
`BBS:` and `DOORS:` assigns when `C:Assign` exists (axshim makes them otherwise),
starts `SYS:System/RexxMast` when the image has it (ARexx doors), and starts
`C:axshim 115200`, which never returns. Doors need nothing else from
Workbench on AROS; on Kickstart 3.1 the same image boots as long as the door does
not open disk libraries that are not on it.

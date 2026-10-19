# Building an Amiga door image

ENiGMA½ boots each Amiga door from a hard-disk image file: a bare FFS
partition (no RDB) that the emulator mounts as the boot volume. The image needs
the shim, the door library, the startup sequence and the door itself.
`oputil.js amiga-door` builds and changes such images with nothing but
ENiGMA½ (no Python, no amitools, no running board). `make_image.sh` here does
the same with amitools' `xdftool`, for a machine without ENiGMA½.

## oputil

From the ENiGMA½ checkout, for a door unpacked in `~/doors/dreamsweeper/`:

```sh
./oputil.js amiga-door create ~/amiga/dreamsweeper.hdf ~/doors/dreamsweeper
./oputil.js amiga-door create ~/amiga/doors.hdf --size 8M --doors ~/doors/dreamsweeper ~/doors/wallhall
```

`create IMAGE [DOORDIR...]` writes `C/axshim`, `Libs/AEDoor.library` and
`S/Startup-Sequence` from this checkout, then copies each door directory, layout
kept, to `Doors/<directory name>/` in the image (here
`BBS:Doors/dreamsweeper/...`). Empty files and empty directories are kept (some
doors need an empty data file to exist) and files keep their modification
times; everything gets `rwed` protection, which is what doors expect.

| Option | |
|---|---|
| `--size SIZE` | default `2000K`; bytes, or with `K`, `M` or `G`, rounded up to a multiple of 8 KB; at most `2032K` unless `--allow-large` (see below) |
| `--allow-large` | allow a `--size` over 2032 KB: only for an image used with the bundled ROM (enigma-vamiga 0.1.2 and later), Kickstart 3.1 or another ROM that carries the FFS fix; a stock AROS ROM corrupts larger FFS volumes on a write |
| `--name NAME` | volume name, default `BBS` |
| `--doors DIR...` | door directories (the same as listing them after the image) |
| `--workbench ADF` | add ARexx from your Workbench 3.1 disk, for ARexx doors (below) |
| `--force` | replace the image if it exists |

Nothing is written unless the whole image can be built: a door that does not
fit, a name AmigaDOS cannot hold (more than 30 characters, or a `:`), or two
names that differ only in case (AmigaDOS ignores case) stop it with a message.
It lists the image when it is done.

To look at or change an image afterwards:

```sh
./oputil.js amiga-door ls ~/amiga/doors.hdf [DIR]              # recursive listing
./oputil.js amiga-door info ~/amiga/doors.hdf                  # name, space, structure check
./oputil.js amiga-door add ~/amiga/doors.hdf empty.dat Doors/wallhall/wALLhALL.dat
./oputil.js amiga-door add ~/amiga/doors.hdf mathieeedoubbas.library Libs/
./oputil.js amiga-door extract ~/amiga/doors.hdf Doors/wallhall ./wallhall-backup
./oputil.js amiga-door extract ~/amiga/doors.hdf S/Startup-Sequence -
```

`add IMAGE SRC [DST]` copies a file or a directory tree; `DST` is the path in the
image (default: the root), and a `DST` ending in `/`, or an existing directory
when `SRC` is a file, puts `SRC` inside it. A file of the same name is replaced.
`extract IMAGE SRC DST` copies out (`-` writes a file to stdout). Paths in the
image use `/` and may start with a volume name (`BBS:Doors/...`). Change an image
only while none of its doors is in use.

These commands work on any plain OFS or FFS image, ADF floppies included, but
not on partitioned hard-disk images (RDB) or other file systems (PFS, SFS).

- `2000K` is the default and enough for most doors (the shim and library take
  under 100 KB, Workbench's ARexx files about 150 KB). Make it bigger for doors
  with large data files, up to `2032K`: a stock AROS ROM corrupts an FFS volume
  of more than 4066 blocks (2033 KB, the most one bitmap block covers) when a
  door writes to it, and 2032 KB is the largest multiple of 8 KB within that.
  The bundled ROM (enigma-vamiga 0.1.2 and later) and Kickstart 3.1 have no such
  limit; `--allow-large` goes past it for an image used only with them. Every
  session carries the image, so keep it small.
- Name the volume `BBS`. Doors find their files under `BBS:`; the shim also
  assigns `BBS:` to the boot volume, so another name works, but `BBS` keeps paths
  in door docs literal.
- The door's path inside the image is what ENiGMA's door config names, written
  with `BBS:` (for the example, `BBS:Doors/dreamsweeper/dreamsweeper.xim`).

## make_image.sh (xdftool)

The same recipe with [amitools](https://github.com/cnvogelg/amitools)' `xdftool`
(`pip install amitools`):

```sh
python3 -m venv ~/amitools-venv && ~/amitools-venv/bin/pip install amitools
XDFTOOL=~/amitools-venv/bin/xdftool \
    misc/amiga_door/image/make_image.sh [-s 4M] [-n BBS] [-w WB.adf] [-f] ~/amiga/doors.hdf ~/doors/dreamsweeper
```

`-s`, `-n`, `-w` and `-f` are `--size`, `--name`, `--workbench` and `--force`
above; `-x PATH` names the `xdftool` to use. By hand, what it does is:

```sh
A=misc/amiga_door
IMG=~/amiga/dreamsweeper.hdf

xdftool "$IMG" create size=4M + format BBS ffs \
    + makedir C + makedir S + makedir Libs + makedir Doors + makedir Doors/DreamSweeper \
    + write "$A/bin/axshim" C/axshim \
    + write "$A/bin/AEDoor.library" Libs/AEDoor.library \
    + write "$A/image/Startup-Sequence" S/Startup-Sequence \
    + write ~/doors/dreamsweeper/dreamsweeper.xim Doors/DreamSweeper/dreamsweeper.xim

xdftool "$IMG" list             # check what is on it
```

`xdftool` writes files with the current time and skips `/dev/null` without a
word: to put an empty file on an image, `: > empty.dat` and write that.

## What else a door may need

Copy these from the door's archive, keeping its layout under `BBS:`:

- **Data and config files** the door reads or creates. Some doors refuse to create
  their data file and need an empty one to exist (for example Wallhall's
  `wALLhALL.dat`); keep it, empty, in the door directory you give `create`, or
  `add` one later.
- **Icons with tooltypes** (`<door>.info`, `BBS:Commands/BBSCmd/<cmd>.info`): /X
  doors often read their settings from their command icon.
- **Screens and bulletins** under `BBS:` paths the door displays (`JH_SF`/`JH_SG`).
- Files a door reads straight from /X's own data (`BBS:user.data`,
  `BBS:Node<n>/...`) are not emulated; such doors may not work.

Writes a door makes (high scores, walls, answers) land in the image; ENiGMA
writes the changed image back after a clean session.

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
  for l in mathieeedoubbas mathieeedoubtrans mathieeesingtrans; do
      ./oputil.js amiga-door add "$IMG" $l.library Libs/
  done
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
ARexx.** Give `create` your Workbench 3.1 disk image (an ADF of the
"Workbench3.1" disk) with `--workbench`:

```sh
./oputil.js amiga-door create ~/amiga/kickboxing.hdf \
    --workbench ~/amiga/Workbench3.1.adf --doors ~/doors/Kickboxing
```

(`make_image.sh -w ~/amiga/Workbench3.1.adf ...` does the same.) It copies, from
the same paths on the Workbench disk, and stops naming any the disk lacks:

| Files | Why |
|---|---|
| `System/RexxMast` | the ARexx server; the image's `S:Startup-Sequence` starts it before the shim |
| `Libs/rexxsyslib.library`, `Libs/rexxsupport.library` | ARexx itself, and the support functions many scripts `ADDLIB` |
| `Libs/mathieeedoubbas.library`, `mathieeedoubtrans`, `mathieeesingtrans` | rexxsyslib will not start without `mathieeedoubbas`; neither the AROS ROM nor Kickstart 3.1 has it |
| `Rexxc/RX` and the rest of `Rexxc/` | the shim starts every script with `SYS:Rexxc/RX` |
| `C/Avail`, `Copy`, `Date`, `Delete`, `List`, `MakeDir`, `Rename`, `Type`, `Wait` | commands scripts run with `ADDRESS COMMAND` (Hacker runs `avail flush` after every move and ends with an error without it) |

These files are Commodore's (now Cloanto's), licensed with your Workbench: an
image built with `--workbench` is for your own board, do not pass it on. The
same image works with the bundled AROS ROM and with a Kickstart 3.1 ROM:
Workbench 3.1's ARexx runs on both.

Put the script where its documentation says, or anywhere: its own data paths
(`doors:Kickboxing/...`) are what matter, and the door config names the script
(`door: BBS:Doors/Kickboxing/KickBox.Rexx`). Scripts that `ADDLIB` a third-party
library need it in `Libs/` too, with the libraries it opens (The Death Game's
daily reset: `rexxarplib.library`, `screenshare.library`, `diskfont.library` and
`arp.library`).

Without `--workbench`, `doorType: aim` sessions end at once with
`error=no rexxsyslib` (the ENiGMA log says so); XIM and CLI doors are not affected.

## Startup-Sequence

`Startup-Sequence` here is the template: it sets `FailAt` and `Stack`, makes the
`BBS:` and `DOORS:` assigns when `C:Assign` exists (axshim makes them otherwise),
starts `SYS:System/RexxMast` when the image has it (ARexx doors), and starts
`C:axshim 115200`, which never returns. Doors need nothing else from
Workbench on AROS; on Kickstart 3.1 the same image boots as long as the door does
not open disk libraries that are not on it.

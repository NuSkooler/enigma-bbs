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
    misc/amiga_door/image/make_image.sh [-s 4M] [-n BBS] [-f] ~/amiga/doors.hdf ~/doors/dreamsweeper
```

Each door directory is copied, layout kept, to `Doors/<directory name>/` in the
image (here `BBS:Doors/dreamsweeper/...`). `-f` replaces an existing image.

## Recipe

From the ENiGMA½ checkout, for a door unpacked in `~/doors/dreamsweeper/`:

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

- `size=4M` is the default and enough for most doors (the shim and library take
  about 40 KB). Make it bigger for doors with large data files; every session
  carries the image, so keep it small.
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

## Startup-Sequence

`Startup-Sequence` here is the template: it sets `FailAt` and `Stack`, makes the
`BBS:` and `DOORS:` assigns when `C:Assign` exists (axshim makes them otherwise),
and starts `C:axshim 115200`, which never returns. Doors need nothing else from
Workbench on AROS; on Kickstart 3.1 the same image boots as long as the door does
not open disk libraries that are not on it.

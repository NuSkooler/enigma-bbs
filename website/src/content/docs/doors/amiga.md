---
title: Amiga Doors
description: "Run AmiExpress (/X) XIM doors, /X ARexx doors, Paragon doors, C-Net ARexx doors and AmigaDOS CLI doors in the built-in vAmiga emulator, with no external emulator on the server."
sidebar:
    order: 3
---
## Amiga Doors via vAmiga

ENiGMA½ can run Amiga BBS doors written for [AmiExpress](https://www.aminet.net/search?query=amiexpress) (the "/X" family) in an Amiga emulator that is built in: the [vAmiga](https://github.com/dirkwhoffmann/vAmiga) core, compiled to WebAssembly and shipped in the `enigma-vamiga` npm package. There is no external emulator to install, and no Kickstart ROM or Workbench is needed: the package bundles the [AROS](https://aros.org) ROM. The `amiga_door` module runs the emulator in a worker thread and bridges the caller to it.

:::note
An Amiga door is not a standalone program. An XIM door is a client of a running /X node: it asks the BBS for the user's name, the time left, a key, a line of input, or to print something. ENiGMA½ boots a small host shim (`axshim`) inside the emulated Amiga that impersonates a node for the door and relays everything to ENiGMA½ over the emulated serial port. The shim and its library are in the repository (`misc/amiga_door/`); you only need to put a door on a disk image.
:::

ENiGMA½ also runs **CLI doors**: ordinary AmigaDOS programs that read the keyboard and write the screen through their standard input and output, the way many Amiga BBS games were written. See [CLI Doors](#cli-doors). It runs **ARexx doors**, the /X scripts marked `TYPE=AIM`, on an image that carries ARexx from your own Workbench 3.1; see [ARexx Doors](#arexx-doors). It runs **Paragon doors**, written for Paragon, StarNet and MAX's BBS (and run by /X as `TYPE=TIM`); see [Paragon Doors](#paragon-doors). And it runs **C-Net ARexx doors**, the ARexx "pfiles" of C-Net Amiga, again with ARexx from your Workbench 3.1; see [C-Net ARexx Doors](#c-net-arexx-doors).

---

### How It Works

1. A caller picks the menu entry. ENiGMA½ checks `nodeMax`, that no other session is using the door's image (for a door that saves its changes), and the caller's time left.
2. The first session for a door image boots the emulator (at warp speed, about 0.4 seconds), waits for the shim to say it is ready, and keeps a snapshot of the booted machine in memory. Later sessions restore that snapshot in about 50 ms.
3. ENiGMA½ hands the shim the user block (name, location, security level, time left, terminal size, and so on) and the door to run. This takes the place of a drop file.
4. The door runs. Its output goes to the caller, and the caller's keys go to the door.
5. When the door ends, the shim reports how it ended. After a clean exit, ENiGMA½ writes the disk changes the session made back to the image file.

Each caller gets an emulator of their own, so one caller per emulator. The emulator is only a copy of the disk; see [Persistence](#persistence) for what that means for a door with shared state.

---

### Prerequisites

- **The `enigma-vamiga` package.** It is a dependency of ENiGMA½ and is installed with the rest.
- **A door image.** A small hard-disk image holding the shim, a startup sequence and the door. See [Building a Door Image](#building-a-door-image).
- **Optionally, a Kickstart ROM.** The bundled AROS ROM runs most /X doors. If a door needs the real thing, supply your own Kickstart 3.1 ROM with `rom`. ENiGMA½ does not ship Kickstart; see [Licensing](#licensing).

---

### ROMs and Workbench

**No ROM is needed.** The `enigma-vamiga` package bundles the AROS replacement Kickstart, published under the AROS Public License 1.1, and every door type runs on it (ARexx doors too, once the ARexx files from a Workbench disk are on the image). The bundled pair is the AROS build of 2026-08-20:

| File | Size | CRC32 |
|------|------|-------|
| `aros-rom.bin` | 524,288 bytes | `CDB1F414` |
| `aros-ext.bin` | 524,288 bytes | `6F9A4AD2` |

This `aros-rom.bin` carries a fix to AROS's FFS bitmap handling (enigma-vamiga 0.1.2 and later), which is why its CRC32 differs from the stock AROS build, `7AE94477`; the package's `roms/README.md` explains the fix. With the bundled ROM an image of any size is safe to write to. A stock AROS ROM, supplied through the `rom` option, corrupts an FFS volume of more than one bitmap block (2032 KB) when a door writes to it, so ENiGMA½ logs a warning at startup when `rom` is set and the image is bigger than that; keep the image at 2032 KB or less with such a ROM.

**Kickstart 3.1, optional.** If you own a Kickstart ROM you may use it instead with the `rom` option: a plain, unencrypted, 524,288-byte image whose file name ends in `.rom` or `.bin` (the emulator refuses other extensions before looking at the contents). Kickstart 3.1 is the tested release; the shim needs Kickstart 2.0 or newer. Known-good dumps, by CRC32:

| Revision | Machine | CRC32 |
|----------|---------|-------|
| 40.63 | A500 / A600 / A2000 | `FC24AE0D` or `88136CA9` (the emulator's two known dumps); `FC8A3FD2` is also widely listed |
| 40.68 | A1200 | `1483A091` |
| 40.69 | A1200 | `1D9AA278` |
| 40.68 | A3000 | `EFB239CC` |
| 40.68 | A4000 | `D6BAE334` |

The A1200 and A500-family builds are the right ones for the machine ENiGMA½ emulates; the A3000 and A4000 builds also boot but carry drivers for hardware the emulator lacks. A ROM the emulator does not recognise still loads, as "Unknown ROM". To check a file:

```bash
python3 -c "import zlib,sys;print('%08X'%zlib.crc32(open(sys.argv[1],'rb').read()))" kick40068-a1200.rom
xxd -l 4 kick40068-a1200.rom      # 1114 4ef9 for a plain Kickstart 2.0+ image
```

Amiga Forever ships its ROMs encrypted: the file is 524,299 bytes and starts with the text `AMIROMTYPE1`. Decrypt it once with the `rom.key` from the same folder, since the emulator refuses encrypted files:

```bash
python3 misc/amiga_door/tools/decrypt_af_rom.py amiga-os-310-a1200.rom rom.key kick40068-a1200.rom
```

Kickstart and Workbench are copyrighted (Amiga Corporation; Cloanto's Amiga Forever is the usual legitimate source). Their licences cover personal systems and say nothing about public servers, which is one more reason the bundled AROS ROM is the default.

**Workbench 3.1, needed only for ARexx doors.** The AROS ROM has no ARexx, so `oputil.js amiga-door create --workbench` (or `make_image.sh -w`) reads `RexxMast`, `rexxsyslib.library`, `rexxsupport.library`, the IEEE math libraries, `Rexxc/` and a few `C:` commands from your own `Workbench3.1.adf`. A Workbench 3.1 set is six ADF images of 901,120 bytes each: Workbench3.1, Extras3.1, Fonts, Install3.1, Locale and Storage3.1; only the first is read. Amiga Forever ships them unencrypted. For reference, one clean set of dumps has these CRC32 values; other dumps differ in date stamps, and the image builder checks contents rather than checksums:

| Disk | CRC32 |
|------|-------|
| Workbench3.1 | `D233484C` |
| Extras3.1 | `32F55078` |
| Fonts | `63470DE4` |
| Install3.1 | `B631F796` |
| Locale | `E0E5DE81` |
| Storage3.1 | `4BD38EF4` |

An image that contains Workbench files is licensed material: keep it on your server and out of any public repository.

---

### Building a Door Image

A door image is a bare FFS partition (no RDB), named `BBS`, 2000 KB (`create`'s default) unless the door needs more. Every session carries a copy of the image, so keep it small. It holds:

```
C/axshim                  the host shim
Libs/AEDoor.library       the library most doors open
S/Startup-Sequence        boots straight into the shim
Doors/<name>/...          the door, its data files, icons and configuration
```

Build one with `oputil.js amiga-door create`. It needs nothing but ENiGMA½: no Python, no amitools, no running board.

```bash
./oputil.js amiga-door create ~/amiga/dreamsweeper.hdf ~/doors/dreamsweeper
```

It takes the image to create and one or more door directories (listed after the image, or with `--doors DIR...`). Each directory is copied, layout kept, to `Doors/<directory name>/` in the image, so the door above ends up at `BBS:Doors/dreamsweeper/...`. Empty files and empty directories are kept, and files keep their modification times. Give several directories to put several doors on one image. Options:

| Option | |
|---|---|
| `--size SIZE` | Image size, default `2000K`: bytes, or with `K`, `M` or `G`. Rounded up to a multiple of 8 KB. At most `2032K` unless `--allow-large` is given. |
| `--allow-large` | Allow a `--size` over 2032 KB (up to 2097144K, 8 KB short of 2 GB). Only for an image used with the bundled ROM, Kickstart 3.1 or another ROM that carries the FFS fix. |
| `--name NAME` | Volume name, default `BBS`. |
| `--workbench ADF` | Add ARexx from your own Workbench 3.1 disk, for ARexx doors; see [ARexx Doors](#arexx-doors). |
| `--force` | Replace the image if it exists. |

The limit is there because a stock AROS ROM corrupts an FFS volume of more than 4066 blocks (2033 KB, the most one bitmap block covers) as soon as a door writes to it; 2032 KB is the largest multiple of 8 KB within it. The ROM bundled with ENiGMA½ (enigma-vamiga 0.1.2 and later) carries the fix, as does Kickstart 3.1, but an image kept at 2032 KB or less also works with a stock AROS ROM given through `rom`, so `create` refuses a larger one unless you pass `--allow-large`.

When it finishes it lists the image so you can check it. Nothing is written unless the whole image can be built: a door that does not fit (give a larger `--size`), a file name AmigaDOS cannot hold (longer than 30 characters, or with a `:`), or two file names that differ only in case (AmigaDOS ignores case) stop it with a message saying which.

A door directory or file name that the module would refuse in a `door` path (a quote, an asterisk, a backtick or one of `$ ; < > |`, a control character, or text outside Latin-1) does not stop the build: `create` warns that the module will refuse a `door:` path through it, so rename it before you point a menu entry at it.

The script `make_image.sh` (for a machine with amitools but not ENiGMA½) takes the same image and door directories with `-s`, `-n`, `-x PATH` (the `xdftool`), `-w ADF`, `-p DIR` and `-c FILE` (see [C-Net ARexx Doors](#c-net-arexx-doors)) and `-f`; its default size is `2000K` too.

The `door` setting names the door's path inside the image, written with `BBS:`, for example `BBS:Doors/dreamsweeper/dreamsweeper.xim`.

To look at or change an image later:

| Command | |
|---|---|
| `amiga-door add IMAGE SRC [DST]` | Copy a local file or directory into the image. `DST` is its path in the image (default: the root). A `DST` ending in `/`, or an existing directory when `SRC` is a file, puts `SRC` inside it. A file of the same name is replaced. |
| `amiga-door ls IMAGE [DIR]` | List the image, or a directory in it, with sizes, protection bits and dates. |
| `amiga-door extract IMAGE SRC DST` | Copy a file or directory out of the image; `DST` of `-` writes a file to standard output. |
| `amiga-door info IMAGE` | Volume name, file system, size and free space, and a check of the image's structure. |

```bash
./oputil.js amiga-door add ~/amiga/cli-doors.hdf ~/amiga/libs/mathieeedoubbas.library Libs/
./oputil.js amiga-door ls ~/amiga/doors.hdf Doors/dreamsweeper
./oputil.js amiga-door extract ~/amiga/doors.hdf Doors/wallhall ~/backup/wallhall
```

Change an image only while none of its doors is in use: a session that ends cleanly writes the door's changes back over the file. The next session after a change boots the image afresh, since the snapshot of the booted machine belongs to the old file.

These commands read and write any plain OFS or FFS image, floppy `.adf` files included (handy for taking a door off its distribution disk with `extract`). They do not handle partitioned hard-disk images (with a Rigid Disk Block) or other file systems such as PFS and SFS.

:::tip[Without oputil]
`misc/amiga_door/image/make_image.sh` builds the same image with `xdftool` from [amitools](https://github.com/cnvogelg/amitools) (`pip install amitools`), for a machine that has Python but not ENiGMA½. Its options are `-s SIZE`, `-n VOLUME`, `-w ADF`, `-f` and `-x PATH` for `xdftool`; see `misc/amiga_door/image/README.md`.
:::

#### Test-driving a door

`amiga-door console` plays a door on your own terminal, with no running ENiGMA½ and no menu entry: it boots the image in-process, starts the door as a caller would, and wires your keyboard to it.

```bash
./oputil.js amiga-door console ~/amiga/doors.hdf --door BBS:Doors/XIMTest/XIMTest
./oputil.js amiga-door console ~/amiga/cli.hdf --door BBS:Doors/spac/space --type cli \
    --args '"{name}" DOORS:spac/' --user Hero --no-persist
```

`--door` is required; `--type` is `xim` (the default), `cli` or `aim`, or another door type the shim on the image supports (`tim` for Paragon doors and `cnetrexx` for C-Net ARexx doors, once that door support is installed; a shim without it ends the session with `error=unknown door type`). `--user` sets the caller's name, and `--args`, `--console-mode`, `--mainline`, `--encoding` (try `cp437` for doors drawn for a PC terminal), `--rom` and `--rows`/`--cols` mirror the module's settings. The door's output is shown as UTF-8 with the Amiga console's control codes translated and the shim's control frames removed. When the door ends, the shim's summary (`status`, the commands it used, the files it changed) is printed. If the door exited normally (`status: ok`) its changes are written back to the image, as in a real session; `--no-persist` leaves the image alone. Press Ctrl+] to hang up and quit; that ends the session with status `carrier`, so nothing is written. Use it on a copy of an image, or one no running board is using.

#### What a door may need

Copy these from the door's archive, keeping its layout under `BBS:`:

- **Data and configuration files** the door reads. Some doors will not create their data file and need an empty one to exist; `amiga-door create` and `add` keep empty files.
- **Icons with tooltypes** (`<door>.info`). /X doors often read their settings from their icon.
- **Screens and bulletins** the door displays.

Doors that read files straight from an /X install's own data (`BBS:user.data`, `BBS:Node<n>/...`) are not supported; they may not work.

#### Finding doors

/X doors are on [Aminet](https://aminet.net) under `comm/amiex`, and many are still distributed by the AmiExpress community; the [Up Rough door repository](https://doors.uprough.net) collects thousands of Amiga BBS door archives. Read the AEDoor 2.8 documentation that comes with the door developer kits if a door's own notes are thin. ENiGMA½ supports XIM doors, which are the ones that talk to a node through `AEDoor.library`, /X ARexx doors, CLI doors and Paragon doors (below); Paragon and MAX's BBS doors are on Aminet under `comm/maxs`, and C-Net's ARexx pfiles under `comm/cnet`. It does not run C-Net's C pfiles, which read C-Net's own memory structures.

---

### Configuration

Add an `amiga_door` module entry to a menu in `menu.hjson`. `name`, `image` and `door` are required.

| Item | Required | Description |
|------|----------|-------------|
| `name` | Yes | Door name. Used as a key for tracking concurrent sessions. |
| `image` | Yes | Path to the door's `.hdf` image. |
| `door` | Yes | Amiga path of the door executable inside the image, such as `BBS:Doors/DreamSweeper/dreamsweeper.xim`. For an ARexx or C-Net ARexx door, the script's full path (`BBS:Doors/Kickboxing/KickBox.Rexx`, `PFILES:Badlibs/badlibs`), with no blanks, quotes or shell characters. XIM, Paragon and CLI door paths may have blanks but none of the shell characters `"` `*` `` ` `` `$` `;` `<` `>` `\|`. At most 199 characters, Latin-1, no control characters. |
| `doorType` | No | `xim` for an AmiExpress XIM door, `aim` for an /X [ARexx door](#arexx-doors), `tim` for a [Paragon door](#paragon-doors) (Paragon, StarNet, MAX's BBS; /X's `TYPE=TIM`), `cnetrexx` for a [C-Net ARexx door](#c-net-arexx-doors), `cli` for a [CLI door](#cli-doors). Default: `xim`. |
| `consoleMode` | No | CLI doors only: `cooked` (line input with echo, like an Amiga Shell window) or `raw` (each key as typed) until the door picks a mode itself. Default: `cooked`. |
| `doorDir` | No | The door's current directory. Default: the door's own directory. |
| `doorArgs` | No | XIM and ARexx doors: extra arguments after the node number; Paragon doors: after the line number. C-Net ARexx doors: the script's arguments (C-Net gave pfiles none). CLI doors: the door's whole argument line. `{name}`, `{node}`, `{level}` and `{timeleft}` are filled in; see [CLI Doors](#cli-doors). The arguments may be at most 199 characters and the whole command line (door path, node number, arguments) 299, with placeholders counted at their widest; a longer setting is refused. |
| `doorStack` | No | Door stack size in bytes, 4096 to 1048576. Default: `32768`. |
| `assigns` | No | Assigns the door's installation asks for, as `{ NAME: 'PATH' }` (for example `{ MSE: 'BBS:Doors/MSE' }`), made for each session before the door's path is checked. Names are 1 to 30 letters, digits, `_`, `.` or `-`; paths are Amiga paths on the image, without `;`. A path that is not on the image ends the session with an error. Any door type. |
| `env` | No | Environment variables the door reads from `ENV:`, as `{ NAME: 'value' }` (an empty value is allowed), set for each session; `ENV:` is made in `RAM:` when the image has none. Any door type. `assigns` and `env` each take at most 199 characters in all (`NAME=value` pairs joined with `;`). |
| `mainline` | No | The /X command line the caller "typed". Some doors parse it. Default: empty. |
| `rom` | No | Path to a Kickstart ROM. Default: the bundled AROS ROM. |
| `extRom` | No | Path to an extension ROM. Default: the bundled AROS extension with the bundled ROM, none with your own `rom`. |
| `cpu` | No | `68000`, `68010` or `68EC020`. Default: `68EC020`. |
| `chipKb` | No | Chip RAM: `256`, `512`, `1024` or `2048`. Default: `512`. |
| `slowKb` | No | Slow RAM, 0 to 1536 in steps of 256. Default: `512`. |
| `fastKb` | No | Fast RAM, 0 to 8192 in steps of 64. Default: `8192`. The core supports at most 8 MB. |
| `overclock` | No | CPU speed multiplier, 1 to 16. Default: `1`. |
| `baud` | No | The serial line's rate for the session: `9600`, `19200`, `38400`, `57600`, `115200` or `230400`. Default: `115200`. See [Serial Line](#serial-line) for the rate to pick. Needs an image built with axshim 1.5 or later; an older shim keeps its own rate, and ENiGMA½ logs a warning. |
| `nodeMax` | No | Maximum concurrent sessions. `0` is unlimited. Default: `0`, or `1` when `sharedState` is true and `nodeMax` is not set. |
| `sharedState` | No | The door writes state all callers share (high scores, a wall): sets `nodeMax` to 1 when `nodeMax` is not set. A door that persists already runs one caller at a time per image. Default: `false`. See [Persistence](#persistence). |
| `tooManyArt` | No | Art spec shown when `nodeMax` is reached or the door's image is in use by another session. |
| `minTimeLeftMinutes` | No | Refuse to start if the caller has less time than this left today. |
| `notEnoughTimeArt` | No | Art spec shown when `minTimeLeftMinutes` refuses. |
| `encoding` | No | Encoding of the door's output. Default: `latin1`. Any encoding `iconv-lite` knows. |
| `amigaConsole` | No | Translate the Amiga console's controls for PC terminals (see [Characters and Fonts](#characters-and-fonts)). Default: `true` with a Latin-1 `encoding`, `false` with any other. |
| `font` | No | SyncTERM font for the door's duration: a font name or alias, or `none` to leave the caller's font alone. Default: `topaz`. |
| `persist` | No | Write the door's disk changes back to the image. Default: `true`. |
| `persistOn` | No | The exit statuses after which to persist: any of `ok`, `carrier`, `timeout`, `break`, `error`. Default: `['ok', 'carrier']` for `xim` doors, `['ok']` for `cli`, `aim`, `tim` and `cnetrexx` doors; a list you give always wins. `carrier`, `timeout` and `break` persist only if the door ended by itself (see [Persistence](#persistence)). |
| `log` | No | XIM, ARexx, Paragon and C-Net ARexx doors: log every request the door makes at debug level. Default: `false`. |
| `panicGraceSeconds` | No | C-Net ARexx doors: after a hangup (when every command answers `###PANIC`), how long the script has to save and stop before it gets a Ctrl-C, 0 to 25. `0` stops it before it sees its answer, for doors that would save `###PANIC` as a player's name. Default: `10`. |
| `wordWrap` | No | C-Net ARexx doors: break the door's text between words at the caller's width, as C-Net did. Default: `true`. |
| `warpBootSeconds` | No | How long the first boot runs flat out, 0 to 3600. Default: `30`. |
| `regTimeoutSeconds` | No | XIM doors: the door must register with the shim within this many seconds (Paragon doors: send their first request), 0 to 86400; `0` waits for ever. Default: `30`. |
| `disconnectGraceSeconds` | No | After a hangup, time-up or break, how long ENiGMA½ waits for the door to finish and the shim to report its exit, 1 to 3600. The shim itself gives a door 30 seconds and then reports it gone, so keep this above 30. With no report in time nothing is saved. Default: `35`. |
| `inputTimeoutSeconds` | No | A door waiting this long for a key gives up, 1 to 86400. Default: `users.idleLogoutSeconds`, or the shim's 300 seconds. |
| `crlf` | No | A line feed in the door's output goes out as CR LF, as /X does. Default: `true`. |
| `timezoneMinutes` | No | Minutes east of UTC for the Amiga clock, -720 to 840. Default: the server's. |

Every problem in a door's configuration is reported at once in the log (`Could not start Amiga door`), and the caller sees "<name> could not be run. Please let the sysop know." and is returned to the menu. A missing `image`, `rom` or `extRom` file is handled the same way.

The only system setting is `doors.amiga.snapshotCacheEntries` (default `4`): how many booted-machine snapshots ENiGMA½ keeps in memory, about 1.5 MB each, one per door image and machine configuration. A door without a snapshot boots instead of restoring. `0` turns the cache off.

#### Example Menu Entry

```hjson
doorDreamSweeper: {
    desc: Playing DreamSweeper
    module: amiga_door
    config: {
        name: DreamSweeper
        image: /home/enigma/amiga/dreamsweeper.hdf
        door: BBS:Doors/dreamsweeper/dreamsweeper.xim
        sharedState: true
        tooManyArt: DOORMANY
    }
}
```

---

### CLI Doors

Many Amiga BBS games, RPGs and strategy games among them, are not XIM doors but ordinary AmigaDOS programs: they read keys from standard input and write to standard output, and the BBS ran them in a raw console. Set `doorType: cli` for these. The shim then starts the program with its input and output connected to the caller (it acts as the program's console), and nothing else changes: the same image, snapshot, persistence and font handling apply.

- **The caller is anonymous unless you pass them.** A CLI door cannot ask the BBS anything, so it knows only what is on its command line. Put what the door's documentation asks for in `doorArgs` with these placeholders:

  | Placeholder | Becomes |
  |---|---|
  | `{name}` | The caller's user name, as one quoted argument |
  | `{node}` | The node number |
  | `{level}` | The caller's security level |
  | `{timeleft}` | Minutes left in the caller's session |

  `{name}` is always one quoted argument, with characters the Amiga shell would act on (quotes, `*`, back-quotes, `$`, `;`, `<`, `>`, `|`) replaced by `_`, so a user name can neither run a command nor add a keyword to the door's command line. A name too long for the room left on the command line is cut short inside its quotes. Do not put quotes around placeholders yourself. There is no node number in front of a CLI door's arguments.

- **Console mode.** The console starts in cooked mode: typed text is echoed, Backspace edits and Return ends a line, as in an Amiga Shell window. A door that wants single keys switches to raw mode itself. Some doors expect the BBS to have opened a raw console already ("run it through a RAW cli" in their notes) and never switch; set `consoleMode: raw` for those.

- **Hangups.** When the caller hangs up or runs out of time, the door's input ends (end of file), its output is refused, and it gets a Ctrl-C, which is what Amiga BBSes did. A door that ignores all of that is given up on after 30 seconds, as for XIM doors, and its exit is reported as `carrier` (or `timeout`). Nothing it wrote is saved in that case, because the door was still running (see [Persistence](#persistence)).

- **Libraries.** A door may need libraries that are not in the AROS ROM. Doors compiled with DICE C (Battle Grounds, for one) quit at once, without a word, unless `mathieeedoubbas.library`, `mathieeedoubtrans.library` and `mathieeesingtrans.library` are in `BBS:Libs`. Copy them from the [AROS m68k distribution](https://aros.sourceforge.io) (`Libs/` on the boot ISO), or from your own Workbench disks when you use a Kickstart ROM.

- **Character set.** Many CLI doors draw with the PC (CP437) character set rather than the Amiga's. For those set `encoding: cp437` and `font: none`.

A CLI door's image needs axshim 1.1 or later (the shim in this repository); an image made with axshim 1.0 runs it as an XIM door, which fails.

#### Example: Battle Grounds and Global War

Battle Grounds 0.9e is a hack-and-slash RPG with persistent characters. It takes the caller's name on its command line, reads `S:BattleG.config` (whose first line is its data directory, here `doors:rpgs/battleg/`, which needs a `Users` directory) and expects a raw console. Global War 2.19 is a multi-player strategy game that takes AmigaDOS keyword arguments and keeps its world in `DOORS:GlobalWar/GW.dat`. Both are in the Up Rough door repository.

```hjson
doorBattleGrounds: {
    desc: Playing Battle Grounds
    module: amiga_door
    config: {
        name: BattleGrounds
        image: /home/enigma/amiga/cli-doors.hdf
        door: BBS:Doors/rpgs/battleg/bg
        doorType: cli
        consoleMode: raw
        doorArgs: "{name}"
        encoding: cp437
        font: none
        sharedState: true
    }
}
doorGlobalWar: {
    desc: Playing Global War
    module: amiga_door
    config: {
        name: GlobalWar
        image: /home/enigma/amiga/cli-doors.hdf
        door: BBS:Doors/GlobalWar/GlobalWar
        doorType: cli
        doorArgs: "{name} ACCESS {level} PAGELENGTH 24 TIMELEFT {timeleft}"
        encoding: cp437
        font: none
        sharedState: true
    }
}
```

Global War 2.19 cannot save on a fresh install: it deletes `GW.dat` before renaming its new save over it, and gives up when there is no `GW.dat` to delete. Give it the empty world it would have written, the text `GLOBAL WAR v2.19 ` (with the trailing space) padded with zero bytes to 68 bytes: `printf 'GLOBAL WAR v2.19 ' > GW.dat && truncate -s 68 GW.dat`, then copy it into the image with `./oputil.js amiga-door add IMAGE GW.dat Doors/GlobalWar/`.

### ARexx Doors

Many /X doors were written as ARexx scripts. Their command icon says `TYPE=AIM`, and the script starts with `parse arg NODE`, `options results` and `address value "AERexxControl"NODE`. AmiExpress ran them through its REXXDOOR utility; the shim takes REXXDOOR's place: it opens the `AERexxControl<node>` port, runs the script with `RX`, and answers its commands (`GETUSER`, `PUTUSTR`/`PUTUSER`, `TRANSMIT`, `SENDSTRING`, `GETCHAR`, `QUERY`, `SHOWFILE`, `REMOVERESERVED`, `SHUTDOWN` and the rest) from the same user information XIM doors get. Set `doorType: aim` and name the script in `door`.

:::caution[ARexx doors need your own Workbench 3.1]
AROS has no ARexx. The image must carry ARexx from your own Workbench 3.1 disk: RexxMast, `rexxsyslib.library`, `rexxsupport.library`, the IEEE math libraries ARexx needs, `SYS:Rexxc/RX` and a few C: commands scripts call. `oputil.js amiga-door create --workbench` copies them from an ADF of the Workbench 3.1 disk, and the image's `S:Startup-Sequence` starts RexxMast. Those files are licensed with your Workbench: keep the image to your own board. Workbench 3.1's ARexx runs with the bundled AROS ROM, so you do not need a Kickstart ROM as well.
:::

```sh
./oputil.js amiga-door create ~/amiga/kickboxing.hdf \
    --workbench ~/amiga/Workbench3.1.adf --doors ~/doors/Kickboxing
```

`--workbench` copies, from the same paths on the Workbench disk: `System/RexxMast`; `Libs/rexxsyslib.library` and `rexxsupport.library`; `Libs/mathieeedoubbas.library`, `mathieeedoubtrans` and `mathieeesingtrans` (rexxsyslib will not start without the first, and neither the AROS ROM nor Kickstart 3.1 has it); `Rexxc/RX` and the rest of `Rexxc/`; and `C/Avail`, `Copy`, `Date`, `Delete`, `List`, `MakeDir`, `Rename`, `Type` and `Wait`, which scripts run with `ADDRESS COMMAND`. It stops, naming the files, if the disk lacks any of them.

- **Where the script goes.** Anywhere on the image: a script finds its data through its own paths (KickBoxing uses `doors:Kickboxing/...`; `DOORS:` is `BBS:Doors`), and `door` names the script.
- **Hangups and time.** When the caller hangs up, runs out of time or leaves the door waiting for a key longer than `inputTimeoutSeconds`, every command the script sends fails with return code 10, as under AmiExpress. Scripts written for /X take that as the cue to save and stop (many set `SIGNAL ON ERROR`); one that carries on gets a Ctrl-C, which stops an ARexx script.
- **Libraries.** A script that `ADDLIB`s a library not on the Workbench disk needs it, and whatever that library opens, in the image's `Libs/`. The Death Game plays without `rexxarplib.library` until its once-a-day reset, which needs rexxarplib together with `screenshare.library`, `diskfont.library` and ARP's `arp.library`.
- **What a script changes in the user record** (`PUTUSER`, for example The Death Game's upload credits) lasts for the session only; ENiGMA½'s user record is not changed.
- **Errors.** An ARexx error in the script (`+++ Error 41 in line 51: Invalid expression`) is logged with the door's exit. Without ARexx on the image, the session ends at once and the log says `no rexxsyslib`.

#### Example: KickBoxing and Hacker

KickBoxing 1.0 (187 FAC, 1994; Demozoo) is a boxing and training game with Amiga-scene art; Hacker 5.2c (Up Rough door repository) is a hacker-wars game. Hacker draws with PC characters. For KickBoxing, move `KickBox.Rexx` into the archive's `Kickboxing` directory and give that directory to `amiga-door create` (as above); for Hacker, give it the archive's `hacker` directory.

```hjson
doorKickBoxing: {
    desc: Playing KickBoxing
    module: amiga_door
    config: {
        name: KickBoxing
        image: /home/enigma/amiga/arexx-doors.hdf
        door: BBS:Doors/Kickboxing/KickBox.Rexx
        doorType: aim
        doorStack: 40000
        sharedState: true
    }
}
doorHacker: {
    desc: Playing Hacker
    module: amiga_door
    config: {
        name: Hacker
        image: /home/enigma/amiga/arexx-doors.hdf
        door: BBS:Doors/hacker/hacker.rexx
        doorType: aim
        doorStack: 50000
        encoding: cp437
        font: none
        sharedState: true
    }
}
```

Hacker runs `avail flush` after every command and stops with an error if the image has no `C:Avail`, so build its image with `--workbench`. Its archive ships the author's own players: leave out `hackerdata/users/*` and `hackerdata/userlist` for a fresh game.

### Paragon Doors

Paragon, StarNet and MAX's BBS had a door protocol of their own, which AmiExpress also ran (`TYPE=TIM` in a door's icon) and DLG, Xenolink and DayDream emulated. A Paragon door finds the BBS's `DoorControl<line>` port and sends it its requests: print this, read a line, read a key, the caller's name, time left, show a file, add some minutes. The shim publishes that port and answers, from the same user information XIM doors get. Set `doorType: tim`. Aminet's `comm/maxs` directory holds a few hundred of these doors and utilities for MAX's BBS, games among them (Master Space Empire, The Land of VEX, Sector Wars II, AndroFight, Hamurabi, Killer Instinct, Global War 1.18), and many /X boards ran Paragon doors as `TYPE=TIM`.

- **The line number.** A Paragon door reads its line from the first character of its argument, so it is started as `<door> <digit>`: the last digit of the caller's node. Each caller has an emulated machine of their own, so the lines never collide. Doors that take more arguments get them after it, from `doorArgs`.
- **Install notes.** Paragon doors were installed with an assign or two and sometimes an environment variable in the sysop's `S:Startup-Sequence`, which a door image does not have. Put them in the door's config: `assigns: { MSE: "BBS:Doors/MSE" }` and `env: { MSE: "" }` make `MSE:` and the file `ENV:MSE` for each session. `DOORS:` (`BBS:Doors`) and `PGDOORS:` (the door path Paragon doors are told) are always there. Some doors also look for a file naming the BBS type (The Land of VEX reads `DOORS:bbstype.dat`, which says `maxs`).
- **Characters.** Most of these doors draw with PC characters: set `encoding: cp437` and `font: none`. Line ends are taken care of: Paragon doors end lines with a carriage return, a line feed or both, and each reaches the caller as one new line.
- **Hangups and time.** When the caller hangs up, runs out of time or leaves the door waiting for a key longer than `inputTimeoutSeconds`, every answer the door gets says the carrier is lost, as a Paragon BBS said; doors check that after every request and save and quit. One that carries on gets a Ctrl-C.
- **What a door changes** in the user's record (time it adds, an access level it sets) lasts for the session only; ENiGMA½'s user record is not changed. A door asking for the BBS's editor is refused, as for XIM doors.
- **Libraries.** As with CLI doors, a door that needs `mathieeedoubbas.library` or the like needs it in the image's `Libs/` (the AROS ones serve). Doors compiled with HiSoft BASIC need HiSoft's `hisoftbasic.library` or `hbasic2.library`, which are not freely available; they do not run without them.

#### Example: Master Space Empire and The Land of VEX

Master Space Empire 2.35 (Robert Masters, 1993; Aminet `comm/maxs/mse_2.35.lha`) is a multi-player space strategy game played a few turns a day; The Land of VEX 1.2 (Aminet `comm/maxs/VEXv1_2.lha`) is a fantasy role-playing game in the manner of Legend of the Red Dragon. Put MSE's files in `Doors/MSE/` and VEX's `lod` directory in `Doors/lod/`, with its `bbstype.dat` in `Doors/`, and the AROS `mathieeedoubbas` and `mathieeedoubtrans` libraries in `Libs/` for VEX.

```hjson
doorMSE: {
    desc: Playing Master Space Empire
    module: amiga_door
    config: {
        name: MasterSpaceEmpire
        image: /home/enigma/amiga/paragon-doors.hdf
        door: BBS:Doors/MSE/MSE
        doorType: tim
        assigns: { MSE: "BBS:Doors/MSE" }
        env: { MSE: "" }
        encoding: cp437
        font: none
        sharedState: true
    }
}
doorVEX: {
    desc: Playing The Land of VEX
    module: amiga_door
    config: {
        name: LandOfVEX
        image: /home/enigma/amiga/paragon-doors.hdf
        door: BBS:Doors/lod/Awarrior
        doorType: tim
        encoding: cp437
        font: none
        sharedState: true
    }
}
```

MSE's `env` value holds its options (`FAST`, `TIME`, `INVITE`; see its readme); empty is none. Leave out `PARAGON`, which asks for the BBS's editor.

### C-Net ARexx Doors

C-Net Amiga (versions 3 to 5) ran door games and add-ons as "pfiles", and many were ARexx scripts. C-Net started each one with its port's ARexx host already chosen, so a pfile has no `address` line: it says `options results` and sends C-Net's commands (`TRANSMIT`, `SENDSTRING`, `GETUSER 1`, `PROMPT 30 NORMAL "Your word: "`, `MAYGETCHAR`, `CHANGEWHERE "Playing Bad Libs"`), with C-Net's colour and control codes in its text. The shim takes C-Net's place: it opens the port `CNETREXX<port>` (C-Net counted ports from 0, so the caller on node 1 is port 0), starts the script the way C-Net did, and answers from the same user information other doors get. Set `doorType: cnetrexx` and name the script in `door`.

:::caution[C-Net ARexx doors need your own Workbench 3.1]
As for /X ARexx doors, the image must carry ARexx from your Workbench 3.1 disk: build it with `make_image.sh -w`. See [ARexx Doors](#arexx-doors).
:::

Pfiles live under `PFILES:`, and many hard-code it (Bad Libs looks in `PFILES:BADLIBS/`). `make_image.sh -p DIR` puts a pfile's directory in `PFiles/` on the image, and the shim assigns `PFILES:` to it. It also makes C-Net's mail tree, `CNET:Mail/Users/`, where pfiles keep files for each caller (in a folder named after the caller's account number, which is their ENiGMA½ user ID). A door that wants something else gets it from `assigns`. Give commands a script runs (`address command`) that Workbench does not have with `-c`:

```sh
XDFTOOL=~/amitools-venv/bin/xdftool misc/amiga_door/image/make_image.sh \
    -w ~/amiga/Workbench3.1.adf -c ~/amiga/QSort/QSort \
    -p ~/doors/Badlibs -p ~/doors/switchfont -p ~/doors/GoldMine ~/amiga/cnet-doors.hdf
```

- **Text codes.** C-Net's codes in a door's text (`^Yc5` colours, `^Yf1` clear the screen, `^Yn2` new lines, cursor moves) become ANSI for the caller, and the ones that wait work: a key (`{G}`), a line (`{I}`), yes or no (`{?}`), a pause (`{W}`), a file shown inside the text (`{* file}`). Text is word-wrapped at the caller's width (`wordWrap`). C-Net's "More" prompt is not emulated; doors that turn it off and on find it off.
- **Keys.** `GETCHAR` and `MAYGETCHAR` give letters in capitals, as C-Net did; cursor keys reach the door as the caller's terminal sends them (`ESC [ A`), which is what C-Net doors read.
- **The caller.** `GETUSER` answers C-Net's numbered fields from the caller's ENiGMA½ record: handle (1), real name (3), location (4), time left (7, in tenths of a minute), calls (22), port (23), upload and download totals (30 to 33), account number (40), and the rest as an account with nothing in it would. `BBSIDENTIFY` gives the board's and sysop's names. The account number is the caller's ENiGMA½ user ID, so only the root sysop (ID 1) is C-Net's sysop account 1; a C-Net door runs only for a caller who has logged in (on a menu reached before login it says it could not be run, and the log says why). A script that reads C-Net's memory directly (`GETUSER` with a seven-digit number) gets 0 or nothing. The scratch account commands see only the caller's own account; `FINDACCOUNT` finds only the caller.
- **Hangups and time.** When the caller hangs up, runs out of time or leaves the door waiting for a key longer than `inputTimeoutSeconds`, every command answers `###PANIC`, as C-Net did, and `GETCARRIER` says `FALSE`. Doors check for that and save and quit; one that carries on gets a Ctrl-C after `panicGraceSeconds`. Bad Libs runs through its remaining prompts, counts the game and leaves by itself within seconds.
- **What a door changes** in the user's record (`PUTUSER`, `ADDTIME`, `ADDPOINTS`) lasts for the session only. The editor, mail and file transfer commands are refused (a door that offers to mail something says it could not), and `BBSCOMMAND` does nothing.
- **Not supported:** C pfiles (programs, not scripts), and ARexx pfiles that `ADDLIB` `cnet.library` or `cnetc.library` or read C-Net's own data files (its user base, message bases). Sub-pfiles started from a door's text (`{#0 file}`) are not run.

#### Example: Bad Libs, Switchfont and Gold Mine

Bad Libs 1.5 and Switchfont 1.0 are by aNACHRONiST of Phenom Productions, written for C-Net 5 and played on aBSiNTHE BBS (the Up Rough door repository has `pn-badlibs15.zip` and `pn-sf10.zip`). Bad Libs is Mad Libs: it asks for nouns and verbs, shows the story they make, and keeps the busiest players and stories. It sorts those lists with `QSort`, a freeware command on Aminet ([util/cli/QSort.lha](https://aminet.net/package/util/cli/QSort)): put `QSort/QSort` from that archive in `C:` with `-c`. Switchfont lets a SyncTERM caller pick a font with the cursor keys. Gold Mine 2.20 (Dotoran; Aminet `comm/cnet/goldmine.lha`) is a guess-the-square game with a high score list. For each, give `make_image.sh -p` the directory holding the script (`Badlibs/`, `switchfont/`, a `GoldMine/` directory with the `GoldMine` script in it).

```hjson
doorBadLibs: {
    desc: Playing Bad Libs
    module: amiga_door
    config: {
        name: BadLibs
        image: /home/enigma/amiga/cnet-doors.hdf
        door: PFILES:Badlibs/badlibs
        doorType: cnetrexx
        sharedState: true
    }
}
doorSwitchfont: {
    desc: Picking a font
    module: amiga_door
    config: {
        name: Switchfont
        image: /home/enigma/amiga/cnet-doors.hdf
        door: PFILES:switchfont/switchfont
        doorType: cnetrexx
        persist: false
        font: none
    }
}
doorGoldMine: {
    desc: Playing Gold Mine
    module: amiga_door
    config: {
        name: GoldMine
        image: /home/enigma/amiga/cnet-doors.hdf
        door: PFILES:GoldMine/GoldMine
        doorType: cnetrexx
        sharedState: true
    }
}
```

Switchfont's choice is the caller's font while it runs; with `font: none` ENiGMA½ leaves it alone afterwards too. Most C-Net art is Latin-1 for Amiga terminals, which is the default `encoding`; Dotoran's CRAPS draws with PC characters and wants `encoding: cp437`.

---

### Persistence

The door's disk is the image file, and each session works on a copy of it. A door that saves something (a high score, a message on a wall) writes it to that copy. What happens next:

- **After a clean exit** (the door ended normally, status `ok`), ENiGMA½ writes the disk blocks the session changed back into the image file. The next session starts from the saved disk.
- **After a hangup** the door is told the carrier is gone and gets the shim's 30 seconds to save and quit; its exit is reported as `carrier`. ENiGMA½ waits for that report for `disconnectGraceSeconds` (35 by default). If the door ended by itself within that time, it is treated as a clean exit and what it saved is written back, for an XIM door (`carrier` is in the default `persistOn` for `xim` only). If the shim had to give up on a door that was still running, nothing is written, because its disk is in an unknown state; the log says why.
- **After anything else** (the time ran out, an error), nothing is written, so a door that crashed or was cut off halfway leaves the image as it was. `persistOn` widens this if you want, for example `['ok', 'carrier', 'timeout']`. `carrier`, `timeout` and `break` always require that the door ended by itself (the shim reports its return code; `-1` means it was still running when the shim gave up). Remove `carrier` from `persistOn` for a door that does not save cleanly on a hangup: what is written is whatever the door left on its disk.
- **Why CLI, ARexx, Paragon and C-Net doors differ.** On a hangup a CLI door is sent end-of-file and a break, an ARexx door a break, a Paragon door that has not quit five seconds after being told the carrier is lost a break too, and a C-Net ARexx door one after `panicGraceSeconds`, so a return code does not prove the door finished its writes: it may simply have been interrupted. Their default `persistOn` is therefore `['ok']`, and a hangup mid-game leaves the image as it was. An XIM door is not interrupted; it only sees carrier-lost replies to its input requests and normally saves and quits, so `carrier` stays in its default. Add `carrier` to `persistOn` for a CLI, ARexx, Paragon or C-Net door you know saves safely on a break.
- **How it is written.** The changed blocks go into a copy of the image in the same directory, which is synced to disk and then renamed over the image. A server crash, a full disk or a stopped ENiGMA½ at any moment leaves either the old image or the new one, never a mix of the two. If the write takes longer than 30 seconds the caller is returned to the menu, but the write is left to finish (for up to five minutes) rather than being cut off. Persisting needs the image's directory to be writable by ENiGMA½ with free space for a second copy of the image, and the image must be a plain file, not a single-file bind mount (the rename fails); the log says so when it does. What gets saved is whatever the door left on its disk: a door that exits cleanly with its own files in a bad state is saved that way.
- **When the disk changed**, the cached snapshots of that image are dropped, since they hold the old disk. The next session boots and caches a fresh one.
- `persist: false` makes every session start from the image as it is, whatever the door writes.

Because sessions are independent copies, two callers on one image could not see each other's writes, and each would write back the disk blocks it changed over the other's (directory and allocation blocks among them). So a door that persists (the default) holds its image for the whole session: while one caller is in it, anyone who picks a door on the same image, this door or another, is told it is busy (`tooManyArt`, or "Too many active instances"), just as `nodeMax` refuses. The image is released once the door has exited and its changes are written. ENiGMA½ also checks, before writing, that the image file is still the one the session started from; if something else changed it meanwhile (a sysop's `xdftool`, a copy put in place), the session's changes are not written and the log says `NOT persisted`.

Sharing an image therefore serialises callers: all the persisting doors on one image run one caller at a time between them. Give doors their own images when you want them to run side by side; separate images run in parallel. A door that keeps nothing between sessions (a single-player game with no saved files) can set `persist: false`: it then never holds its image and runs on as many nodes as `nodeMax` allows, every session starting from the image as it is.

---

### Serial Line

The door and ENiGMA½ talk over the emulated Amiga's serial port, and the shim drives it the way a careful Amiga terminal program would. It raises RTS (the Amiga's "ready to receive" line) when it opens the port, and drops it while its 4 KB receive buffer is three-quarters full and while it is loading a door, so the sending side waits instead of overrunning the port. Keys the door has not read yet stay in that buffer, and ENiGMA½ keeps the rest of a long paste and hands it over as the door takes it.

`baud` sets the line rate for a session. Inside the emulator the rate only paces the bytes; what decides whether a rate works is whether the emulated CPU fetches each byte before the next one arrives. The emulator ENiGMA½ ships today (enigma-vamiga 0.1) holds each received byte until the Amiga has read the one before, so every rate works with it, and the default stays `115200`. A real Amiga has no such help, and the emulator is due to lose it. Without it, these rates are the fastest that measured lossless with the AROS ROM:

| CPU | `baud` |
|---|---|
| 68EC020 at 7 MHz (`cpu: 68EC020`, `overclock: 1`, the defaults) | `38400` |
| 68EC020 at 14 MHz (`overclock: 2`, an A1200's clock) | `57600` |
| 68000 at 7 MHz (and the 68010, which is hardly faster) | `19200` |

Kickstart 3.1 (`rom`) handles the serial interrupt faster than AROS and keeps up with `57600` at 7 MHz. At `115200` a 7 MHz machine without the emulator's help loses bytes, as a real one does. A rate is 10 bits per character: 38400 is 3840 characters a second each way, more than any modem caller had, and a full 80x25 ANSI screen arrives in about a second. Between sessions the shim listens at 38400 (19200 on a 68000), whatever `baud` says, because the user block it receives at the start of a session cannot be sent twice.

**Pasted text that used to vanish.** Before axshim 1.5 the shim kept at most 4 KB of keys the door had not read and threw away the rest, and lost one more key when a 4 KB paste came before the door started reading; a long paste into a door that was busy drawing its screen lost its end. Now the keys wait: the door gets every one of them, as fast as it reads, for as long as it keeps taking keys. (A door that takes no key at all for 3 seconds while its 4 KB of unread keys is full is treated as no longer reading, and what it cannot take is dropped, so a hang-up still reaches it.) A door that keeps reading but very slowly, one key every few seconds, with more than about 7 KB of a paste still unread, can hold the caller's hang-up behind those keys for longer than `disconnectGraceSeconds` (35 by default); ENiGMA½ then stops the session without saving, so what an XIM door would have saved on the hang-up is lost. ENiGMA½ keeps up to 1 MB of a caller's unread input and logs a warning if that ever fills. From enigma-vamiga 0.1.3 the emulator honours the shim's RTS (ENiGMA½ turns this on for images with axshim 1.5 or later), so a door that reads nothing for a while after more than 8 KB of input no longer loses keys; with 0.1.2 and older it can lose about one key in every tenth of a second it waits. Images built before axshim 1.5 have the old shim: rebuild them with `make_image.sh` to get this.

---

### Characters and Fonts

Amiga doors write ISO 8859-1 (Latin-1) text and draw with the Amiga's Topaz font. Two things follow:

- Amiga console controls that PC terminals do not share are translated for the caller: the single-byte control sequence introducer `0x9B` becomes `ESC [`, a form feed (the Amiga's clear screen, which also drops the font on a SyncTERM-style terminal) becomes `ESC[2J ESC[H`, the cursor on/off sequences `ESC[ p` and `ESC[0 p` become `ESC[?25h` and `ESC[?25l`, a console reset keeps the font, and a cursor position below the screen is moved onto it (see below). Everything else in the door's output is passed through. This is done for doors with a Latin-1 `encoding` (the default) only: a door that writes CP437 is a PC-style door, where `0x9B` is a cent sign, and its output is left as written. `amigaConsole: true` or `false` overrides that either way.
- With a Latin-1 `encoding` and the Topaz font, door bytes reach the caller as they are, and the caller's terminal shows them through the font. With another `encoding`, the output is converted to the caller's character set first (a character split across two writes is kept whole).
- When the font is not `none`, ENiGMA½ switches a SyncTERM-compatible terminal to the font (`topaz` by default) before the door starts and back afterwards (`ESC[0;42 D` before, `ESC[0;0 D` after, for Topaz). Callers whose terminals do not support SyncTERM fonts see the door in their own font: the text is readable, and the Amiga's box-drawing and graphic characters show as whatever Latin-1 gives them. If most of your callers are in that position, set `font: none`.

The terminal size is the caller's, polled once a second, so a resize reaches the door. Many /X doors were written on PAL Amigas with 32-line screens and place text on rows 26 and 27 without asking; with the Amiga console translation on, a cursor position below the caller's last row is moved onto the last row, which is what the Amiga console itself does, so an 80x25 caller sees the bottom of the layout overwritten rather than the screen scrolling. Callers with taller terminals (SyncTERM's 80x50 modes, for example) see the full layout, and a door that asks the BBS for the screen length is told the real one. Time left is polled every five seconds, so a door sees the caller's budget shrink as it does everywhere else on the board.

---

### Limits

- **CPU:** the 68000, 68010 and 68EC020 only. There is no 68030, 68040 or 68060, and no FPU.
- **Memory:** at most 8 MB of fast RAM. The AROS ROM needs at least 1 MB in total (chip plus slow plus fast).
- **Images up to 4066 blocks (2033 KB) with a stock AROS ROM.** An FFS volume bigger than that needs a second bitmap block, which a stock AROS ROM's filesystem misreads: when a door writes, it can take blocks that belong to other files and overwrite them. Use 2032 KB or less (the largest 8 KB multiple under the 4066-block limit). The ROM bundled with ENiGMA½ (enigma-vamiga 0.1.2 and later) carries the fix and Kickstart 3.1's filesystem has no such limit, but `make_image.sh` makes 2000K images by default and warns about bigger ones, so an image also works with a stock AROS ROM given through `rom`. Check an image you built bigger with amitools' `xdfscan`.
- **One caller per emulator.** Every session is its own emulated machine, with the memory and CPU that costs. Use `nodeMax` to bound it.
- **ARexx needs your Workbench.** AROS does not have ARexx; ARexx and C-Net ARexx doors run only on an image built with your own Workbench 3.1 (`amiga-door create --workbench`).
- **No transfers from doors.** A door cannot start a ZMODEM (or any other) file transfer to the caller.
- **No sysop break.** There is no way for the sysop to break into a running door's session from the door.
- **No `JH_EF` editor.** A door that asks the BBS for its full-screen editor is refused, and the door carries on without it.
- **XIM, ARexx, Paragon, C-Net ARexx and CLI doors only.** C-Net's C pfiles, which read C-Net's own memory, and ARexx pfiles that need `cnet.library` are not supported; nor are doors for other BBSes' libraries (DLG's, Xenolink's).
- **CLI doors have no window.** A CLI door that asks its console for the window size gets no answer; it should take the screen length from its command line.

---

### Troubleshooting

**The door never registers.** The shim waited `regTimeoutSeconds` for the door to announce itself and gave up, and the caller was returned to the menu. Turn on `log: true` and read the debug log. Usual causes: the `door` path is wrong (it must be a path inside the image, written with `BBS:`), the door needs a file or library that is not on the image (it will fail quietly before it reaches the shim), or the door is not an XIM door.

**A CLI door ends at once, with no output.** It could not start or quit before printing anything, usually for want of a library. The exit is logged with the door's return code (`rc`). Check the libraries the door needs (see [CLI Doors](#cli-doors)) and that its configuration files are where its documentation says.

**An ARexx door ends at once.** The log line for the exit says why. `error=no rexxsyslib`: the image has no ARexx; build it with `amiga-door create --workbench`. `ARexx is not running`: RexxMast is not on the image or did not start. `script ended without a host command` with an `out=` text: the script stopped before it said anything, usually an ARexx error (shown) or a missing `ADDLIB` library.

**A C-Net ARexx door stops with "Error: ... Line: ..."** on the screen. Most pfiles trap every failed command (`SIGNAL ON ERROR`) and print where it happened. The usual cause is a command the script runs with `address command` that is not on the image (Bad Libs needs `C:QSort`; Workbench's own commands come with `-w`), or a missing directory under `PFILES:` or `CNET:`. An exit with `script ended without a host command` is a script ARexx could not run at all (the `out=` text says why), or a `door` path that is not a script.

**A Paragon door ends at once.** The exit is logged with `door exited without a DoorControl request` and the first line the door printed, often its own complaint: a port it could not find (the door wants another BBS type or a line argument of its own; see its notes), a missing assign or library. A door that waits for something before its first request is reported after `regTimeoutSeconds`.

**A CLI door waits for Return after every key.** It expects a raw console and never asks for one; set `consoleMode: raw`.

**Unknown ROM.** The ROM given as `rom` is not one vAmiga knows. Use the bundled ROM, or a Kickstart ROM from a supported release (Kickstart 3.1 is the target).

**"File does not match its type" for a ROM.** vAmiga picks how to read a ROM from its file extension. A ROM file with no `.rom` or `.bin` extension is rejected with this message. Rename the file, for example `kick31.rom`.

**The image is not bootable.** The emulator booted but the shim never said hello. Check that the image is an FFS partition made by `oputil.js amiga-door create` (or `make_image.sh`), that `C/axshim` and `S/Startup-Sequence` are on it (`oputil.js amiga-door info` checks its structure and `ls` shows what is on it), and that the first session logs "Amiga door snapshot cached". A raw floppy `.adf` is not a hard-disk image.

**The first caller waits a moment, later ones do not.** The first session boots the machine; the others restore a snapshot. A restart of ENiGMA½ empties the cache.

**A door's changes vanish.** The session did not end cleanly (see `persistOn`), `persist` is `false`, or the image file was changed by something else while the door ran (the log says `NOT persisted`).

**"Too many active instances" with nobody in the door.** Another door on the same image is in use: a door that persists holds its image for the whole session. Give the doors separate images to run them at the same time.

**The door's screen looks wrong.** Try `font: none` for callers without SyncTERM fonts, or set `encoding` if the door writes something other than Latin-1.

---

### Licensing

- **AROS** is distributed under the AROS Public License (APL 1.1). The ROM in `enigma-vamiga` is unchanged AROS, and its source is available from [aros.org](https://aros.org).
- **Kickstart** and Workbench belong to their owners. ENiGMA½ does not ship them, and you do not need them. If you use `rom`, it is your own copy.
- **vAmiga** is under the Mozilla Public License 2.0. The patches ENiGMA½ makes to it are published in the `enigma-vamiga` package.
- **axshim** and the image tools are BSD-2-Clause. `AEDoor.library` is NilBBS's MIT-licensed library, with a small patch. Doors are their authors' own, under whatever terms they chose.

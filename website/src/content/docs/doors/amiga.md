---
title: Amiga Doors
description: "Run AmiExpress (/X) XIM doors in the built-in vAmiga emulator, with no external emulator on the server."
sidebar:
    order: 3
---
## Amiga Doors via vAmiga

ENiGMA½ can run Amiga BBS doors written for [AmiExpress](https://www.aminet.net/search?query=amiexpress) (the "/X" family) in an Amiga emulator that is built in: the [vAmiga](https://github.com/dirkwhoffmann/vAmiga) core, compiled to WebAssembly and shipped in the `enigma-vamiga` npm package. There is no external emulator to install, and no Kickstart ROM or Workbench is needed: the package bundles the [AROS](https://aros.org) ROM. The `amiga_door` module runs the emulator in a worker thread and bridges the caller to it.

:::note
An Amiga door is not a standalone program. An XIM door is a client of a running /X node: it asks the BBS for the user's name, the time left, a key, a line of input, or to print something. ENiGMA½ boots a small host shim (`axshim`) inside the emulated Amiga that impersonates a node for the door and relays everything to ENiGMA½ over the emulated serial port. The shim and its library are in the repository (`misc/amiga_door/`); you only need to put a door on a disk image.
:::

---

### How It Works

1. A caller picks the menu entry. ENiGMA½ checks `nodeMax` and the caller's time left.
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

### Building a Door Image

A door image is a bare FFS partition (no RDB), named `BBS`, 4 MB unless the door needs more. Every session carries a copy of the image, so keep it small. It holds:

```
C/axshim                  the host shim
Libs/AEDoor.library       the library most doors open
S/Startup-Sequence        boots straight into the shim
Doors/<name>/...          the door, its data files, icons and configuration
```

Build one with `misc/amiga_door/image/make_image.sh`. It uses `xdftool` from [amitools](https://github.com/cnvogelg/amitools), which you install in a Python virtual environment:

```bash
python3 -m venv ~/amitools-venv
~/amitools-venv/bin/pip install amitools

XDFTOOL=~/amitools-venv/bin/xdftool \
    misc/amiga_door/image/make_image.sh ~/amiga/dreamsweeper.hdf ~/doors/dreamsweeper
```

The script takes the image to create and one or more door directories. Each directory is copied, layout kept, to `Doors/<directory name>/` in the image, so the door above ends up at `BBS:Doors/dreamsweeper/...`. Give several directories to put several doors on one image. Options: `-s SIZE` (default `4M`), `-n VOLUME` (default `BBS`), `-x PATH` for `xdftool`, and `-f` to replace an existing image. When it finishes it lists the image so you can check it.

The `door` setting names the door's path inside the image, written with `BBS:`, for example `BBS:Doors/dreamsweeper/dreamsweeper.xim`.

#### What a door may need

Copy these from the door's archive, keeping its layout under `BBS:`:

- **Data and configuration files** the door reads. Some doors will not create their data file and need an empty one to exist; `make_image.sh` keeps empty files.
- **Icons with tooltypes** (`<door>.info`). /X doors often read their settings from their icon.
- **Screens and bulletins** the door displays.

Doors that read files straight from an /X install's own data (`BBS:user.data`, `BBS:Node<n>/...`) are not supported; they may not work.

#### Finding doors

/X doors are on [Aminet](https://aminet.net) under `comm/amiex`, and many are still distributed by the AmiExpress community. Read the AEDoor 2.8 documentation that comes with the door developer kits if a door's own notes are thin. ENiGMA½ supports XIM doors, which are the ones that talk to a node through `AEDoor.library`; it does not run standalone Amiga programs or doors written for other BBS software.

---

### Configuration

Add an `amiga_door` module entry to a menu in `menu.hjson`. `name`, `image` and `door` are required.

| Item | Required | Description |
|------|----------|-------------|
| `name` | Yes | Door name. Used as a key for tracking concurrent sessions. |
| `image` | Yes | Path to the door's `.hdf` image. |
| `door` | Yes | Amiga path of the door executable inside the image, such as `BBS:Doors/DreamSweeper/dreamsweeper.xim`. |
| `doorDir` | No | The door's current directory. Default: the door's own directory. |
| `doorArgs` | No | Extra arguments passed after the node number. |
| `doorStack` | No | Door stack size in bytes, 4096 to 1048576. Default: `32768`. |
| `mainline` | No | The /X command line the caller "typed". Some doors parse it. Default: empty. |
| `rom` | No | Path to a Kickstart ROM. Default: the bundled AROS ROM. |
| `extRom` | No | Path to an extension ROM. Default: the bundled AROS extension with the bundled ROM, none with your own `rom`. |
| `cpu` | No | `68000`, `68010` or `68EC020`. Default: `68EC020`. |
| `chipKb` | No | Chip RAM: `256`, `512`, `1024` or `2048`. Default: `512`. |
| `slowKb` | No | Slow RAM, 0 to 1536 in steps of 256. Default: `512`. |
| `fastKb` | No | Fast RAM, 0 to 8192 in steps of 64. Default: `8192`. The core supports at most 8 MB. |
| `overclock` | No | CPU speed multiplier, 1 to 16. Default: `1`. |
| `nodeMax` | No | Maximum concurrent sessions. `0` is unlimited. Default: `0`, or `1` when `sharedState` is true and `nodeMax` is not set. |
| `sharedState` | No | The door writes state all callers share (high scores, a wall). Default: `false`. See [Persistence](#persistence). |
| `tooManyArt` | No | Art spec shown when `nodeMax` is reached. |
| `minTimeLeftMinutes` | No | Refuse to start if the caller has less time than this left today. |
| `notEnoughTimeArt` | No | Art spec shown when `minTimeLeftMinutes` refuses. |
| `encoding` | No | Encoding of the door's output. Default: `latin1`. Any encoding `iconv-lite` knows. |
| `font` | No | SyncTERM font for the door's duration: a font name or alias, or `none` to leave the caller's font alone. Default: `topaz`. |
| `persist` | No | Write the door's disk changes back to the image. Default: `true`. |
| `persistOn` | No | The exit statuses after which to persist: any of `ok`, `carrier`, `timeout`, `break`, `error`. Default: `['ok']`. |
| `log` | No | Log every request the door makes at debug level. Default: `false`. |
| `warpBootSeconds` | No | How long the first boot runs flat out, 0 to 3600. Default: `30`. |
| `regTimeoutSeconds` | No | The door must register with the shim within this many seconds, 0 to 86400; `0` waits for ever. Default: `30`. |
| `inputTimeoutSeconds` | No | A door waiting this long for a key gives up, 1 to 86400. Default: `users.idleLogoutSeconds`, or the shim's 300 seconds. |
| `crlf` | No | A line feed in the door's output goes out as CR LF, as /X does. Default: `true`. |
| `timezoneMinutes` | No | Minutes east of UTC for the Amiga clock, -720 to 840. Default: the server's. |

Every problem in a door's configuration is reported at once in the log, and the caller is told the door could not be run.

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

### Persistence

The door's disk is the image file, and each session works on a copy of it. A door that saves something (a high score, a message on a wall) writes it to that copy. What happens next:

- **After a clean exit** (the door ended normally, status `ok`), ENiGMA½ writes the disk blocks the session changed back into the image file. The next session starts from the saved disk.
- **After anything else** (the caller hung up, the time ran out, an error), nothing is written, so a door that crashed halfway cannot corrupt the image. `persistOn` widens this if you want, for example `['ok', 'timeout']`.
- **When the disk changed**, the cached snapshots of that image are dropped, since they hold the old disk. The next session boots and caches a fresh one.
- `persist: false` makes every session start from the image as it is, whatever the door writes.

Because sessions are independent copies, two callers running a door at the same time cannot see each other's writes, and the second to finish would overwrite the first. A door with state all callers share wants `sharedState: true`, which allows one caller at a time unless you set `nodeMax` yourself. A door that keeps no shared state, a game of solitaire for example, can run on several nodes.

---

### Characters and Fonts

Amiga doors write ISO 8859-1 (Latin-1) text and draw with the Amiga's Topaz font. Two things follow:

- Amiga console controls that PC terminals do not share are translated for the caller: the single-byte control sequence introducer `0x9B` becomes `ESC [`, a form feed (the Amiga's clear screen, which also drops the font on a SyncTERM-style terminal) becomes `ESC[2J ESC[H`, the cursor on/off sequences `ESC[ p` and `ESC[0 p` become `ESC[?25h` and `ESC[?25l`, and a console reset keeps the font. Everything else in the door's output is passed through. With a Latin-1 `encoding` (the default) and the Topaz font, door bytes reach the caller as they are, and the caller's terminal shows them through the font. With another `encoding`, the output is converted to the caller's character set first.
- When the font is not `none`, ENiGMA½ switches a SyncTERM-compatible terminal to the font (`topaz` by default) before the door starts and back afterwards (`ESC[0;42 D` before, `ESC[0;0 D` after, for Topaz). Callers whose terminals do not support SyncTERM fonts see the door in their own font: the text is readable, and the Amiga's box-drawing and graphic characters show as whatever Latin-1 gives them. If most of your callers are in that position, set `font: none`.

The terminal size is the caller's, polled once a second, so a resize reaches the door. Time left is polled every five seconds, so a door sees the caller's budget shrink as it does everywhere else on the board.

---

### Limits

- **CPU:** the 68000, 68010 and 68EC020 only. There is no 68030, 68040 or 68060, and no FPU.
- **Memory:** at most 8 MB of fast RAM. The AROS ROM needs at least 1 MB in total (chip plus slow plus fast).
- **One caller per emulator.** Every session is its own emulated machine, with the memory and CPU that costs. Use `nodeMax` to bound it.
- **No ARexx.** AROS does not have it, so doors that drive other programs through ARexx will not work with the bundled ROM.
- **No transfers from doors.** A door cannot start a ZMODEM (or any other) file transfer to the caller.
- **No sysop break.** There is no way for the sysop to break into a running door's session from the door.
- **No `JH_EF` editor.** A door that asks the BBS for its full-screen editor is refused, and the door carries on without it.
- **XIM doors only,** as described above.

---

### Troubleshooting

**The door never registers.** The shim waited `regTimeoutSeconds` for the door to announce itself and gave up, and the caller was returned to the menu. Turn on `log: true` and read the debug log. Usual causes: the `door` path is wrong (it must be a path inside the image, written with `BBS:`), the door needs a file or library that is not on the image (it will fail quietly before it reaches the shim), or the door is not an XIM door.

**Unknown ROM.** The ROM given as `rom` is not one vAmiga knows. Use the bundled ROM, or a Kickstart ROM from a supported release (Kickstart 3.1 is the target).

**"File does not match its type" for a ROM.** vAmiga picks how to read a ROM from its file extension. A ROM file with no `.rom` or `.bin` extension is rejected with this message. Rename the file, for example `kick31.rom`.

**The image is not bootable.** The emulator booted but the shim never said hello. Check that the image is an FFS partition made by `make_image.sh` (or the recipe in `misc/amiga_door/image/README.md`), that `C/axshim` and `S/Startup-Sequence` are on it, and that the first session logs "Amiga door snapshot cached". A raw floppy `.adf` is not a hard-disk image.

**The first caller waits a moment, later ones do not.** The first session boots the machine; the others restore a snapshot. A restart of ENiGMA½ empties the cache.

**A door's changes vanish.** The session did not end cleanly (see `persistOn`), `persist` is `false`, or two callers ran the door at once. Set `sharedState: true`.

**The door's screen looks wrong.** Try `font: none` for callers without SyncTERM fonts, or set `encoding` if the door writes something other than Latin-1.

---

### Licensing

- **AROS** is distributed under the AROS Public License (APL 1.1). The ROM in `enigma-vamiga` is unchanged AROS, and its source is available from [aros.org](https://aros.org).
- **Kickstart** and Workbench belong to their owners. ENiGMA½ does not ship them, and you do not need them. If you use `rom`, it is your own copy.
- **vAmiga** is under the Mozilla Public License 2.0. The patches ENiGMA½ makes to it are published in the `enigma-vamiga` package.
- **axshim** and the image tools are BSD-2-Clause. `AEDoor.library` is NilBBS's MIT-licensed library, with a small patch. Doors are their authors' own, under whatever terms they chose.

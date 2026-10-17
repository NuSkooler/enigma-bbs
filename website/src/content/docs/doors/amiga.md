---
title: Amiga Doors
description: "Run AmiExpress (/X) XIM doors, /X ARexx doors and AmigaDOS CLI doors in the built-in vAmiga emulator, with no external emulator on the server."
sidebar:
    order: 3
---
## Amiga Doors via vAmiga

ENiGMA½ can run Amiga BBS doors written for [AmiExpress](https://www.aminet.net/search?query=amiexpress) (the "/X" family) in an Amiga emulator that is built in: the [vAmiga](https://github.com/dirkwhoffmann/vAmiga) core, compiled to WebAssembly and shipped in the `enigma-vamiga` npm package. There is no external emulator to install, and no Kickstart ROM or Workbench is needed: the package bundles the [AROS](https://aros.org) ROM. The `amiga_door` module runs the emulator in a worker thread and bridges the caller to it.

:::note
An Amiga door is not a standalone program. An XIM door is a client of a running /X node: it asks the BBS for the user's name, the time left, a key, a line of input, or to print something. ENiGMA½ boots a small host shim (`axshim`) inside the emulated Amiga that impersonates a node for the door and relays everything to ENiGMA½ over the emulated serial port. The shim and its library are in the repository (`misc/amiga_door/`); you only need to put a door on a disk image.
:::

ENiGMA½ also runs **CLI doors**: ordinary AmigaDOS programs that read the keyboard and write the screen through their standard input and output, the way many Amiga BBS games were written. See [CLI Doors](#cli-doors). And it runs **ARexx doors**, the /X scripts marked `TYPE=AIM`, on an image that carries ARexx from your own Workbench 3.1; see [ARexx Doors](#arexx-doors).

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

### ROMs and Workbench

**No ROM is needed.** The `enigma-vamiga` package bundles the AROS replacement Kickstart, published under the AROS Public License 1.1, and every door type runs on it (ARexx doors too, once the ARexx files from a Workbench disk are on the image). The bundled pair is the AROS build of 2026-08-20:

| File | Size | CRC32 |
|------|------|-------|
| `aros-rom.bin` | 524,288 bytes | `7AE94477` |
| `aros-ext.bin` | 524,288 bytes | `6F9A4AD2` |

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

**Workbench 3.1, needed only for ARexx doors.** The AROS ROM has no ARexx, so `make_image.sh -w` reads `RexxMast`, `rexxsyslib.library`, `rexxsupport.library`, the IEEE math libraries, `Rexxc/` and a few `C:` commands from your own `Workbench3.1.adf`. A Workbench 3.1 set is six ADF images of 901,120 bytes each: Workbench3.1, Extras3.1, Fonts, Install3.1, Locale and Storage3.1; only the first is read. Amiga Forever ships them unencrypted. For reference, one clean set of dumps has these CRC32 values; other dumps differ in date stamps, and the image builder checks contents rather than checksums:

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

/X doors are on [Aminet](https://aminet.net) under `comm/amiex`, and many are still distributed by the AmiExpress community; the [Up Rough door repository](https://doors.uprough.net) collects thousands of Amiga BBS door archives. Read the AEDoor 2.8 documentation that comes with the door developer kits if a door's own notes are thin. ENiGMA½ supports XIM doors, which are the ones that talk to a node through `AEDoor.library`, /X ARexx doors and CLI doors (below). It does not run doors written for the message ports of other BBS software (Paragon, CNet, including CNet's ARexx doors).

---

### Configuration

Add an `amiga_door` module entry to a menu in `menu.hjson`. `name`, `image` and `door` are required.

| Item | Required | Description |
|------|----------|-------------|
| `name` | Yes | Door name. Used as a key for tracking concurrent sessions. |
| `image` | Yes | Path to the door's `.hdf` image. |
| `door` | Yes | Amiga path of the door executable inside the image, such as `BBS:Doors/DreamSweeper/dreamsweeper.xim`. For an ARexx door, the script's full path (`BBS:Doors/Kickboxing/KickBox.Rexx`), with no blanks, quotes or shell characters. |
| `doorType` | No | `xim` for an AmiExpress XIM door, `aim` for an /X [ARexx door](#arexx-doors), `cli` for a [CLI door](#cli-doors). Default: `xim`. |
| `consoleMode` | No | CLI doors only: `cooked` (line input with echo, like an Amiga Shell window) or `raw` (each key as typed) until the door picks a mode itself. Default: `cooked`. |
| `doorDir` | No | The door's current directory. Default: the door's own directory. |
| `doorArgs` | No | XIM and ARexx doors: extra arguments after the node number. CLI doors: the door's whole argument line. `{name}`, `{node}`, `{level}` and `{timeleft}` are filled in; see [CLI Doors](#cli-doors). |
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
| `log` | No | XIM and ARexx doors: log every request the door makes at debug level. Default: `false`. |
| `warpBootSeconds` | No | How long the first boot runs flat out, 0 to 3600. Default: `30`. |
| `regTimeoutSeconds` | No | XIM doors: the door must register with the shim within this many seconds, 0 to 86400; `0` waits for ever. Default: `30`. |
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

### CLI Doors

Many Amiga BBS games, RPGs and strategy games among them, are not XIM doors but ordinary AmigaDOS programs: they read keys from standard input and write to standard output, and the BBS ran them in a raw console. Set `doorType: cli` for these. The shim then starts the program with its input and output connected to the caller (it acts as the program's console), and nothing else changes: the same image, snapshot, persistence and font handling apply.

- **The caller is anonymous unless you pass them.** A CLI door cannot ask the BBS anything, so it knows only what is on its command line. Put what the door's documentation asks for in `doorArgs` with these placeholders:

  | Placeholder | Becomes |
  |---|---|
  | `{name}` | The caller's user name, as one quoted argument |
  | `{node}` | The node number |
  | `{level}` | The caller's security level |
  | `{timeleft}` | Minutes left in the caller's session |

  `{name}` is always one quoted argument, with characters the Amiga shell would act on (quotes, `*`, back-quotes, `$`, `;`, `<`, `>`, `|`) replaced by `_`, so a user name can neither run a command nor add a keyword to the door's command line. Do not put quotes around placeholders yourself. There is no node number in front of a CLI door's arguments.

- **Console mode.** The console starts in cooked mode: typed text is echoed, Backspace edits and Return ends a line, as in an Amiga Shell window. A door that wants single keys switches to raw mode itself. Some doors expect the BBS to have opened a raw console already ("run it through a RAW cli" in their notes) and never switch; set `consoleMode: raw` for those.

- **Hangups.** When the caller hangs up or runs out of time, the door's input ends (end of file), its output is refused, and it gets a Ctrl-C, which is what Amiga BBSes did. A door that ignores all of that is stopped from the caller's side after 30 seconds, as for XIM doors; nothing is saved in that case.

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

Global War 2.19 cannot save on a fresh install: it deletes `GW.dat` before renaming its new save over it, and gives up when there is no `GW.dat` to delete. Give it the empty world it would have written, the text `GLOBAL WAR v2.19 ` (with the trailing space) padded with zero bytes to 68 bytes: `printf 'GLOBAL WAR v2.19 ' > GW.dat && truncate -s 68 GW.dat`, then copy it to `Doors/GlobalWar/GW.dat` in the image.

### ARexx Doors

Many /X doors were written as ARexx scripts. Their command icon says `TYPE=AIM`, and the script starts with `parse arg NODE`, `options results` and `address value "AERexxControl"NODE`. AmiExpress ran them through its REXXDOOR utility; the shim takes REXXDOOR's place: it opens the `AERexxControl<node>` port, runs the script with `RX`, and answers its commands (`GETUSER`, `PUTUSTR`/`PUTUSER`, `TRANSMIT`, `SENDSTRING`, `GETCHAR`, `QUERY`, `SHOWFILE`, `REMOVERESERVED`, `SHUTDOWN` and the rest) from the same user information XIM doors get. Set `doorType: aim` and name the script in `door`.

:::caution[ARexx doors need your own Workbench 3.1]
AROS has no ARexx. The image must carry ARexx from your own Workbench 3.1 disk: RexxMast, `rexxsyslib.library`, `rexxsupport.library`, the IEEE math libraries ARexx needs, `SYS:Rexxc/RX` and a few C: commands scripts call. `make_image.sh -w` copies them from an ADF of the Workbench 3.1 disk, and the image's `S:Startup-Sequence` starts RexxMast. Those files are licensed with your Workbench: keep the image to your own board. Workbench 3.1's ARexx runs with the bundled AROS ROM, so you do not need a Kickstart ROM as well.
:::

```sh
XDFTOOL=~/amitools-venv/bin/xdftool misc/amiga_door/image/make_image.sh \
    -w ~/amiga/Workbench3.1.adf -s 4M ~/amiga/kickboxing.hdf ~/doors/Kickboxing
```

- **Where the script goes.** Anywhere on the image: a script finds its data through its own paths (KickBoxing uses `doors:Kickboxing/...`; `DOORS:` is `BBS:Doors`), and `door` names the script.
- **Hangups and time.** When the caller hangs up, runs out of time or leaves the door waiting for a key longer than `inputTimeoutSeconds`, every command the script sends fails with return code 10, as under AmiExpress. Scripts written for /X take that as the cue to save and stop (many set `SIGNAL ON ERROR`); one that carries on gets a Ctrl-C, which stops an ARexx script.
- **Libraries.** A script that `ADDLIB`s a library not on the Workbench disk needs it, and whatever that library opens, in the image's `Libs/`. The Death Game plays without `rexxarplib.library` until its once-a-day reset, which needs rexxarplib together with `screenshare.library`, `diskfont.library` and ARP's `arp.library`.
- **What a script changes in the user record** (`PUTUSER`, for example The Death Game's upload credits) lasts for the session only; ENiGMA½'s user record is not changed.
- **Errors.** An ARexx error in the script (`+++ Error 41 in line 51: Invalid expression`) is logged with the door's exit. Without ARexx on the image, the session ends at once and the log says `no rexxsyslib`.

#### Example: KickBoxing and Hacker

KickBoxing 1.0 (187 FAC, 1994; Demozoo) is a boxing and training game with Amiga-scene art; Hacker 5.2c (Up Rough door repository) is a hacker-wars game. Hacker draws with PC characters. For KickBoxing, move `KickBox.Rexx` into the archive's `Kickboxing` directory and give that directory to `make_image.sh` (as above); for Hacker, give it the archive's `hacker` directory.

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

Hacker runs `avail flush` after every command and stops with an error if the image has no `C:Avail`, so build its image with `-w`. Its archive ships the author's own players: leave out `hackerdata/users/*` and `hackerdata/userlist` for a fresh game.

---

### Persistence

The door's disk is the image file, and each session works on a copy of it. A door that saves something (a high score, a message on a wall) writes it to that copy. What happens next:

- **After a clean exit** (the door ended normally, status `ok`), ENiGMA½ writes the disk blocks the session changed back into the image file. The next session starts from the saved disk.
- **After anything else** (the caller hung up, the time ran out, an error), nothing is written, so a door that crashed or was cut off halfway leaves the image as it was. `persistOn` widens this if you want, for example `['ok', 'timeout']`.
- **How it is written.** The changed blocks go into a copy of the image in the same directory, which is synced to disk and then renamed over the image. A server crash, a full disk or a stopped ENiGMA½ at any moment leaves either the old image or the new one, never a mix of the two. If the write takes longer than 30 seconds the caller is returned to the menu, but the write is left to finish (for up to five minutes) rather than being cut off. What gets saved is whatever the door left on its disk: a door that exits cleanly with its own files in a bad state is saved that way.
- **When the disk changed**, the cached snapshots of that image are dropped, since they hold the old disk. The next session boots and caches a fresh one.
- `persist: false` makes every session start from the image as it is, whatever the door writes.

Because sessions are independent copies, two callers running a door at the same time cannot see each other's writes, and the second to finish would overwrite the first. A door with state all callers share wants `sharedState: true`, which allows one caller at a time unless you set `nodeMax` yourself. A door that keeps no shared state, a game of solitaire for example, can run on several nodes.

Give each door that keeps shared state its own image. Two such doors on one image can run at the same moment under their own `nodeMax` limits, and each session then writes back the disk blocks it changed; where those blocks overlap, directory and allocation blocks among them, the session that finishes second undoes the first one's changes. One image per shared-state door avoids that entirely. Single-player doors with no shared files can share an image freely.

---

### Characters and Fonts

Amiga doors write ISO 8859-1 (Latin-1) text and draw with the Amiga's Topaz font. Two things follow:

- Amiga console controls that PC terminals do not share are translated for the caller: the single-byte control sequence introducer `0x9B` becomes `ESC [`, a form feed (the Amiga's clear screen, which also drops the font on a SyncTERM-style terminal) becomes `ESC[2J ESC[H`, the cursor on/off sequences `ESC[ p` and `ESC[0 p` become `ESC[?25h` and `ESC[?25l`, and a console reset keeps the font. Everything else in the door's output is passed through. With a Latin-1 `encoding` (the default) and the Topaz font, door bytes reach the caller as they are, and the caller's terminal shows them through the font. With another `encoding`, the output is converted to the caller's character set first.
- When the font is not `none`, ENiGMA½ switches a SyncTERM-compatible terminal to the font (`topaz` by default) before the door starts and back afterwards (`ESC[0;42 D` before, `ESC[0;0 D` after, for Topaz). Callers whose terminals do not support SyncTERM fonts see the door in their own font: the text is readable, and the Amiga's box-drawing and graphic characters show as whatever Latin-1 gives them. If most of your callers are in that position, set `font: none`.

The terminal size is the caller's, polled once a second, so a resize reaches the door. Many /X doors were written on PAL Amigas with 32-line screens and place text on rows 26 and 27 without asking; a cursor position below the caller's last row is moved onto the last row, which is what the Amiga console itself does, so an 80x25 caller sees the bottom of the layout overwritten rather than the screen scrolling. Callers with taller terminals (SyncTERM's 80x50 modes, for example) see the full layout, and a door that asks the BBS for the screen length is told the real one. Time left is polled every five seconds, so a door sees the caller's budget shrink as it does everywhere else on the board.

---

### Limits

- **CPU:** the 68000, 68010 and 68EC020 only. There is no 68030, 68040 or 68060, and no FPU.
- **Memory:** at most 8 MB of fast RAM. The AROS ROM needs at least 1 MB in total (chip plus slow plus fast).
- **One caller per emulator.** Every session is its own emulated machine, with the memory and CPU that costs. Use `nodeMax` to bound it.
- **ARexx needs your Workbench.** AROS does not have ARexx; ARexx doors run only on an image built with your own Workbench 3.1 (`make_image.sh -w`).
- **No transfers from doors.** A door cannot start a ZMODEM (or any other) file transfer to the caller.
- **No sysop break.** There is no way for the sysop to break into a running door's session from the door.
- **No `JH_EF` editor.** A door that asks the BBS for its full-screen editor is refused, and the door carries on without it.
- **XIM, ARexx and CLI doors only.** Doors written for other BBS software's message ports (Paragon, CNet, CNet's ARexx doors) are not supported.
- **CLI doors have no window.** A CLI door that asks its console for the window size gets no answer; it should take the screen length from its command line.

---

### Troubleshooting

**The door never registers.** The shim waited `regTimeoutSeconds` for the door to announce itself and gave up, and the caller was returned to the menu. Turn on `log: true` and read the debug log. Usual causes: the `door` path is wrong (it must be a path inside the image, written with `BBS:`), the door needs a file or library that is not on the image (it will fail quietly before it reaches the shim), or the door is not an XIM door.

**A CLI door ends at once, with no output.** It could not start or quit before printing anything, usually for want of a library. The exit is logged with the door's return code (`rc`). Check the libraries the door needs (see [CLI Doors](#cli-doors)) and that its configuration files are where its documentation says.

**An ARexx door ends at once.** The log line for the exit says why. `error=no rexxsyslib`: the image has no ARexx; build it with `make_image.sh -w`. `ARexx is not running`: RexxMast is not on the image or did not start. `script ended without a host command` with an `out=` text: the script stopped before it said anything, usually an ARexx error (shown) or a missing `ADDLIB` library.

**A CLI door waits for Return after every key.** It expects a raw console and never asks for one; set `consoleMode: raw`.

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

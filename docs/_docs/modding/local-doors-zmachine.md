---
layout: page
title: Local Doors — Z-Machine Interactive Fiction
---
## Z-Machine Interactive Fiction

ENiGMA½ includes a native Z-Machine interpreter for running interactive fiction games — the format used by classic Infocom titles (Zork, Hitchhiker's Guide to the Galaxy, Planetfall, etc.) and hundreds of modern IF competition winners. The `zmachine_door` module runs these games directly in a Node.js worker thread. **No external emulator, no drop file, no BIOS image, and no platform-specific setup** — just a path to a `.z3`, `.z5`, or `.z8` game file.

> :information_source: Each active session runs in its own worker thread, isolated from other users. Multiple players can run the same or different games simultaneously with no cross-talk.

---

### How It Works

1. ENiGMA½ spawns a worker thread per session running [ifvms.js](https://github.com/curiousdannii/ifvms.js) — the same Z-Machine interpreter that powers the [Parchment](https://github.com/curiousdannii/parchment) web-based IF player.
2. The worker loads the game file, runs the VM, and emits text output + input-mode events over `postMessage`.
3. The main thread bridges the user's terminal connection: forwarding keystrokes as line-mode or character-mode input and routing game output back to the client.
4. Glk text styles are rendered as ANSI SGR; Z-Machine `set_colour` calls are hooked at the VM level and emit ANSI color codes inline.
5. Output is word-wrapped server-side to a fixed width, and paginated with "-- More --" prompts so long passages don't scroll off screen.
6. When the user types `QUIT` (or disconnects), the worker exits cleanly and control returns to the calling menu.

---

### Prerequisites

* A Z-Machine game file (`.z3`, `.z4`, `.z5`, or `.z8`). ENiGMA does not bundle any games — sysops provide their own.
* No other setup. No emulator, no drop file, no configuration files.

#### Where to Get Games

Modern free Interactive Fiction is available from the [IF Archive](https://www.ifarchive.org/) — see especially [the Z-code games index](https://www.ifarchive.org/indexes/if-archive/games/zcode/). Thousands of free games are available, including IF Competition winners and pioneering works. Highly recommended starting points:

* **Colossal Cave Adventure** — [`Advent.z5`](https://www.ifarchive.org/if-archive/games/zcode/Advent.z5). The original text adventure (Crowther & Woods, 1976), ported to the Z-Machine by Graham Nelson. Public domain.
* **Photopia** — Adam Cadre's 1998 IF Competition winner. Famous for its color-coded narrative vignettes; runs in our color pipeline.
* **Lost Pig** — Admiral Jota's 2007 IF Comp winner. A beloved starting-point for newcomers to IF.
* **Anchorhead** — Michael Gentry's Lovecraftian horror masterpiece.
* **An Act of Murder** — Christopher Huang's procedurally-generated murder mystery. Every playthrough is a different case.

> :warning: **Infocom games are not legally distributable.** The original commercial Infocom titles (Zork, Hitchhiker's, etc.) remain under copyright and are still sold commercially (e.g. via GOG). Do not redistribute them; if you own a legitimate copy you can use your own `.z5` files.

#### Recommended Directory Layout

By convention, game files live under `misc/zmachine/games/`:

```
misc/zmachine/games/
├── advent.z5
├── photopia.z5
├── LostPig.z8
└── anchor.z8
```

The `game_path` config field is fully configurable — you can put files wherever you like.

---

### Configuration

The `zmachine_door` `config` block supports the following fields:

| Item | Required | Description |
|------|----------|-------------|
| `name` | :+1: | Door name. Used as a key for tracking concurrent sessions. |
| `game_path` | :+1: | Absolute path to the Z-Machine game file (`.z3`, `.z4`, `.z5`, or `.z8`). |
| `nodeMax` | :-1: | Max concurrent sessions. `0` = unlimited (default). |
| `tooManyArt` | :-1: | Art spec to display when `nodeMax` is exceeded. |

No drop file configuration is needed — Z-Machine games don't use them.

---

### Example Menu Entries

#### Colossal Cave Adventure

```hjson
doorAdventure: {
    desc: Playing Colossal Cave Adventure
    module: zmachine_door
    config: {
        name: Adventure
        game_path: /home/enigma/misc/zmachine/games/advent.z5
        nodeMax: 3
        tooManyArt: DOORMANY
    }
}
```

#### Photopia (with color)

```hjson
doorPhotopia: {
    desc: Playing Photopia
    module: zmachine_door
    config: {
        name: Photopia
        game_path: /home/enigma/misc/zmachine/games/photopia.z5
        nodeMax: 3
        tooManyArt: DOORMANY
    }
}
```

#### An Act of Murder (procedural mystery)

```hjson
doorActOfMurder: {
    desc: Playing An Act of Murder
    module: zmachine_door
    config: {
        name: ActOfMurder
        game_path: /home/enigma/misc/zmachine/games/ActofMurder.z8
        nodeMax: 3
        tooManyArt: DOORMANY
    }
}
```

---

### Supported Features

#### Z-Machine versions

| Version | Supported | Notes |
|---------|:---------:|-------|
| z1 / z2 | :-1: | Very early Infocom releases; not implemented by ifvms. |
| **z3** | :+1: | Most classic Infocom games (Zork, Planetfall, Hitchhiker's Guide, etc.) |
| **z4** | :+1: | Trinity, A Mind Forever Voyaging, Bureaucracy |
| **z5** | :+1: | Beyond Zork, Sherlock, Border Zone, and most modern IF. The most common target version for modern games. |
| z6 | :-1: | Graphical variant — requires a full windowed Glk implementation; not applicable for terminal use. |
| **z8** | :+1: | Larger modern IF games (Anchorhead, Lost Pig, Varicella, etc.) |
| Glulx | :-1: | A different virtual machine used by some modern IF; not supported. Most z-machine games also have Glulx builds — use the `.z*` version. |

#### Rendering

| Feature | Notes |
|---------|-------|
| **Glk text styles** | Bold, italic, header, subheader, alert, emphasized, block-quote, preformatted, and user styles rendered as ANSI SGR. |
| **Z-Machine colors** | `set_colour` opcode emits ANSI SGR inline. The 8 standard Z-Machine colors map to the basic ANSI palette. |
| **Word wrap** | Server-side 80-column word wrap with correct handling of embedded ANSI escapes (zero-width). |
| **Pagination** | "-- More -- Press any key to continue" prompts at `termHeight - 2` rows (default 23 for an 80×25 terminal). |
| **Input modes** | Line-mode (with local echo + backspace editing) for commands; character-mode for "press any key" prompts. |
| **Input editing** | Standard server-side line editing: printable keys echoed, backspace erases, Enter submits. |

---

### Known Limitations

These reflect the current MVP state of the module. Some are intentional design choices, others are candidates for future improvement.

* **No save/restore.** Games start fresh each session. In-game `SAVE`/`RESTORE` commands will not persist across sessions. (A SQLite schema is already provisioned for per-user autosave, but the full implementation is deferred — glkote-term's `DumbGlkOte` does not implement `save_allstate`/`restore_allstate`, which are required by ifvms's built-in autosave path.)
* **No split-window / status line.** ifvms's "upper window" (the top-of-screen status line used by some games to display score/turn or draw title art) is not rendered. Games that rely heavily on it (most Infocom z3 titles) still run and their main-window content works fine, but the status line is effectively hidden. Photopia's splash title art is drawn in the upper window, so you'll see its "press any key" indicator without the title artwork.
* **No Glulx support.** `.gblorb` / `.ulx` games don't run. Most modern IF is also available in a `.z*` build — use those.
* **No hyperlinks.** Some IF games support clickable hyperlinks via Glk; terminal clients obviously don't support mouse interaction, so they're rendered as plain text.

---

### See Also

* [Local Doors](local-doors.md) — overview of all local door approaches
* [Native v86 Emulation](local-doors-v86.md) — for DOS-based door games
* [Scripts & Native Binaries](local-doors-abracadabra.md) — for terminal apps / shell scripts
* [ifvms.js](https://github.com/curiousdannii/ifvms.js) — the Z-Machine interpreter used by this module
* [IF Archive](https://www.ifarchive.org/) — repository of free interactive fiction
* [IFDB](https://ifdb.org/) — Interactive Fiction Database with reviews and ratings

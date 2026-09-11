---
title: Scripts & Native Binaries
description: "Launch any local process as a door — native binaries, shell scripts and Python."
sidebar:
    order: 4
---
## Scripts & Native Binaries (abracadabra)

The `abracadabra` module provides a generic solution for launching any local process as a door: native terminal applications, shell scripts, Python scripts, and more. Any process that communicates over stdio works. I/O is bridged through standard I/O (stdio) or a temporary TCP socket server.

:::note
For DOS-specific setups using DOSEMU or QEMU, see [External DOS Emulators](dos-emulation.md). For zero-dependency DOS emulation, see [Native v86 Emulation](v86.md).
:::

---

### Configuration

The `abracadabra` `config` block supports the following fields:

| Item | Required | Description |
|------|----------|-------------|
| `name` | Yes | Used as a key for tracking the number of clients using this door. |
| `dropFileType` | No | Type of drop file to generate. See [Drop File Types](index.md#drop-file-types). Can be omitted or `none`. |
| `cmd` | Yes | Path to the executable to launch. |
| `args` | No | Array of arguments to pass to `cmd`. See [Argument Variables](#argument-variables) below. |
| `preCmd` | No | Path to a pre-command executable or script. Executes before `cmd`. |
| `preCmdArgs` | No | Arguments to pass to `preCmd`. See [Argument Variables](#argument-variables) below. |
| `cwd` | No | Working directory for `cmd`. Defaults to the directory containing `cmd`. |
| `env` | No | Environment variables as a map: `{ SOME_VAR: "value" }` |
| `nodeMax` | No | Max concurrent sessions for this door. Uses `name` as the tracking key. |
| `tooManyArt` | No | Art spec to display when `nodeMax` is exceeded. |
| `io` | No | I/O mode: `stdio` (default) or `socket`. When `socket`, ENiGMA½ spawns a temporary TCP server on `{srvPort}` that the door process connects back to. |
| `commType` | No | What the drop file tells the door it is talking to: `local`, `serial`, or `socket`, defaulting to `socket` when `io: socket` and `local` otherwise. `dropFileType: BBSDEV` takes a wider set with a different default — see [BBSDEV.DRP](#bbsdevdrp). |
| `commParams` | No | The descriptor, handle, UART base and IRQ, or FOSSIL port belonging to `commType`. Read only for `dropFileType: BBSDEV`. See [BBSDEV.DRP](#bbsdevdrp) below. |
| `encoding` | No | The door process's text encoding. Defaults to `cp437`. Linux-native binaries often use `utf8`. |

#### Comm Type

`io` says how ENiGMA½ talks to the process it spawns; `commType` says how the *door* talks to the caller. They are the same thing only when the process ENiGMA½ spawns **is** the door, which is why the default is derived from `io`:

| `commType` | Reported as | Use when |
|------------|-------------|----------|
| `local` (default for the legacy formats) | `DOOR32.SYS` comm type `0`, `DOOR.SYS` `COM0:`, `DORINFO` `0` | The door reads stdin and writes stdout. This covers `io: stdio`, which is nearly every native or scripted door. |
| `serial` | `DOOR32.SYS` comm type `1`, `DOOR.SYS` `COM1:`, `DORINFO` `COM1` | An emulator sits between ENiGMA½ and the door and presents it a COM port — QEMU bridging `{srvPort}` onto `isa-serial`, for example. |
| `socket` | `DOOR32.SYS` comm type `2`, `DOOR.SYS` `COM1:`, `DORINFO` `COM1` | Descriptor sharing by way of [bivrost!](#door32sys-socket-descriptor-sharing). |

:::caution
Setting `commType: socket` does **not** give the door a socket. ENiGMA½ shares a socket *server*, not a descriptor, so `DOOR32.SYS` line 2 is written as `-1` and bivrost! replaces both lines with the real handle. A door handed `2` and `-1` with nothing in between is entitled to refuse to start, and some do.
:::

Doors that ignore these fields entirely — most DOS-era games under an emulator — are unaffected by any of this.

#### BBSDEV.DRP

`dropFileType: BBSDEV` writes a [BBSDEV.DRP](https://github.com/RealDeuce/bbsdev.drp) instead of one of the legacy formats.

The door is told where the file is through the `BBSDEV_DRP` environment variable, which ENiGMA½ sets to the full path before it spawns the process. The value is neither quoted nor shell-escaped, and a door reads it from its own environment. An `env` of your own still replaces ENiGMA½'s environment as it always has; `BBSDEV_DRP` is added to whichever environment the door gets.

`commType` names a wider set of mechanisms, and most of them take a parameter in `commParams`:

| `commType` | `commParams` | The door is handed |
|------------|--------------|--------------------|
| `local` | none | its own local console |
| `stdio` | none | terminal input on stdin, terminal output on stdout. This is the default under `io: stdio` |
| `serial` | file descriptor | an inherited, configured POSIX serial descriptor |
| `winserial` | Win32 `HANDLE` | an inherited, configured Win32 COM handle |
| `uart` | `HHHH,I` — I/O base in four uppercase hex digits, then the IRQ | direct DOS UART access |
| `fossil` | port, 0 through 254 | an initialized FOSSIL interface |

The format also has a `socket` mode, for a socket the door *inherits*. ENiGMA½ never has one to pass on -- `io: socket` stands up a listener the door dials -- so `commType: socket` is refused here rather than written, whatever `commParams` you give it. A value for `serial` or `winserial` has to come from the emulator or bridge you put between ENiGMA½ and the door — QEMU, DOSEMU, [bivrost!](#door32sys-socket-descriptor-sharing).

**A channel ENiGMA½ cannot name stops the door from starting.** Where the legacy formats fall back to `local`, `local` in this format is a positive claim — the door uses its current local console — so writing it for a door reading a socket would describe a screen nobody sees. Instead the drop file is refused, the door does not run, and the reason is logged. That is what happens under `io: socket`: the socket ENiGMA½ shares is a server the door dials rather than a descriptor it inherits, and the format has no token for that. A QEMU or DOSEMU setup says what the door really gets — `commType: uart` with `commParams: 03F8,4`, or `fossil` with `0` — and writes a valid file.

Line 12 names the character set of the door's terminal data, and it is taken from the door's own `encoding` rather than the caller's terminal encoding -- that is the value ENiGMA½ decodes the door's output with, so the two cannot disagree. An encoding it cannot name in the registry's spelling refuses the file rather than guessing; aliases iconv accepts, such as `437` or `win1252`, are folded onto the same name.

Line 13 must be a well-formed BCP 47 tag. A `general.language` that is not one -- `English (US)`, say -- refuses the file rather than writing something a conforming door must reject.

Line 11, the forced logoff time, is written empty: ENiGMA½ imposes no per-call time limit.

#### Argument Variables

The following variables can be used in `args` and `preCmdArgs`:

| Variable | Description | Example |
|----------|-------------|---------|
| `{node}` | Current node number | `1` |
| `{dropFile}` | Drop file filename only | `DOOR.SYS` |
| `{dropFilePath}` | Full path to the generated drop file | `/home/enigma/drop/node1/DOOR.SYS` |
| `{dropFileDir}` | Full path to the drop file directory | `/home/enigma/drop/node1/` |
| `{userAreaDir}` | User-specific save directory | `/home/enigma/drop/node1/NuSkooler/lord/` |
| `{userId}` | Current user ID | `42` |
| `{userName}` | Sanitized username (safe for filenames) | `nuskooler` |
| `{userNameRaw}` | Raw username (may not be filename-safe) | `\/\/izard` |
| `{srvPort}` | Temporary TCP server port (when `io: socket`) | `1234` |
| `{cwd}` | Working directory | `/home/enigma/doors/foo/` |
| `{termHeight}` | Terminal height | `25` |
| `{termWidth}` | Terminal width | `80` |

```hjson
args: [
    "-D", "{dropFilePath}",
    "-N", "{node}",
    "-U", "{userId}"
]
```

---

### Examples

#### Shell Script Door (stdio)

A simple wrapper script that launches a native binary:

```hjson
doorMyGame: {
    desc: My Door Game
    module: abracadabra
    config: {
        name: MyGame
        dropFileType: DOOR
        cmd: /home/enigma/doors/mygame/launch.sh
        args: [ "{node}", "{dropFilePath}" ]
        nodeMax: 4
        tooManyArt: DOORMANY
        io: stdio
    }
}
```

#### Python Script Door (stdio)

```hjson
doorPythonGame: {
    desc: Python Door
    module: abracadabra
    config: {
        name: PythonGame
        dropFileType: DORINFO
        cmd: /usr/bin/python3
        args: [ "/home/enigma/doors/pydoor/main.py", "{node}", "{dropFilePath}" ]
        encoding: utf8
        nodeMax: 8
        io: stdio
    }
}
```

#### Socket-Based Door

Some doors require a socket connection rather than stdio. ENiGMA½ starts a temporary TCP server and passes the port to your script:

```hjson
doorSocketGame: {
    desc: Socket Door
    module: abracadabra
    config: {
        name: SocketGame
        dropFileType: DOOR
        cmd: /home/enigma/doors/socketgame/launch.sh
        args: [ "{node}", "{dropFile}", "{srvPort}" ]
        nodeMax: 1
        io: socket
    }
}
```

---

### DOOR32.SYS Socket Descriptor Sharing

Due to Node.js limitations, ENiGMA½ does not directly support `DOOR32.SYS`-style socket descriptor sharing. However, [bivrost!](https://github.com/NuSkooler/bivrost) bridges this gap. bivrost! is available for Windows and Linux x86/x86_64 (and buildable from Rust on other platforms).

```hjson
doorWithBivrost: {
    desc: Bivrost Example
    module: abracadabra
    config: {
        name: BivrostExample
        dropFileType: DOOR32
        cmd: /home/enigma/utils/bivrost
        args: [
            "--port", "{srvPort}",
            "--dropfile", "{dropFilePath}",
            "--out", "/home/enigma/doors/jezebel",
            "/home/enigma/doors/jezebel/door.exe /home/enigma/doors/jezebel/door32.sys"
        ]
        nodeMax: 1
        tooManyArt: DOORMANY
        io: socket
    }
}
```

See the [bivrost!](https://github.com/NuSkooler/bivrost) documentation for details. Pre-built binaries are also available via [Phenom Productions](https://www.phenomprod.com/) on various boards.

Alternative workarounds: [Telnet Bridge](telnet-bridge.md), or [NET2BBS](http://pcmicro.com/netfoss/guide/net2bbs.html).

---

## See Also
* [Local Doors](index.md)
* [External DOS Emulators](dos-emulation.md)
* [Native v86 Emulation](v86.md)
* [Telnet Bridge](telnet-bridge.md)

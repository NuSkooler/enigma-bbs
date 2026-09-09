---
title: Local Doors — Scripts & Native Binaries
description: "Launch any local process as a door — native binaries, shell scripts and Python."
sidebar:
    order: 13
---
## Scripts & Native Binaries (abracadabra)

The `abracadabra` module provides a generic solution for launching any local process as a door: native terminal applications, shell scripts, Python scripts, and more. Any process that communicates over stdio works. I/O is bridged through standard I/O (stdio) or a temporary TCP socket server.

:::note
For DOS-specific setups using DOSEMU or QEMU, see [External DOS Emulators](local-doors-dos-emulation.md). For zero-dependency DOS emulation, see [Native v86 Emulation](local-doors-v86.md).
:::

---

### Configuration

The `abracadabra` `config` block supports the following fields:

| Item | Required | Description |
|------|----------|-------------|
| `name` | Yes | Used as a key for tracking the number of clients using this door. |
| `dropFileType` | No | Type of drop file to generate. See [Drop File Types](local-doors.md#drop-file-types). Can be omitted or `none`. |
| `cmd` | Yes | Path to the executable to launch. |
| `args` | No | Array of arguments to pass to `cmd`. See [Argument Variables](#argument-variables) below. |
| `preCmd` | No | Path to a pre-command executable or script. Executes before `cmd`. |
| `preCmdArgs` | No | Arguments to pass to `preCmd`. See [Argument Variables](#argument-variables) below. |
| `cwd` | No | Working directory for `cmd`. Defaults to the directory containing `cmd`. |
| `env` | No | Environment variables as a map: `{ SOME_VAR: "value" }` |
| `nodeMax` | No | Max concurrent sessions for this door. Uses `name` as the tracking key. |
| `tooManyArt` | No | Art spec to display when `nodeMax` is exceeded. |
| `io` | No | I/O mode: `stdio` (default) or `socket`. When `socket`, ENiGMA½ spawns a temporary TCP server on `{srvPort}` that the door process connects back to. |
| `commType` | No | What the drop file tells the door it is talking to: `local`, `serial`, or `socket`. Defaults to `socket` when `io: socket`, otherwise `local`. See [Comm Type](#comm-type) below. |
| `encoding` | No | The door process's text encoding. Defaults to `cp437`. Linux-native binaries often use `utf8`. |

#### Comm Type

`io` says how ENiGMA½ talks to the process it spawns; `commType` says how the *door* talks to the caller. They are the same thing only when the process ENiGMA½ spawns **is** the door, which is why the default is derived from `io`:

| `commType` | Reported as | Use when |
|------------|-------------|----------|
| `local` (default) | `DOOR32.SYS` comm type `0`, `DOOR.SYS` `COM0:`, `DORINFO` `0` | The door reads stdin and writes stdout. This covers `io: stdio`, which is nearly every native or scripted door. |
| `serial` | `DOOR32.SYS` comm type `1`, `DOOR.SYS` `COM1:`, `DORINFO` `COM1` | An emulator sits between ENiGMA½ and the door and presents it a COM port — QEMU bridging `{srvPort}` onto `isa-serial`, for example. |
| `socket` | `DOOR32.SYS` comm type `2`, `DOOR.SYS` `COM1:`, `DORINFO` `COM1` | Descriptor sharing by way of [bivrost!](#door32sys-socket-descriptor-sharing). |

:::caution
Setting `commType: socket` does **not** give the door a socket. ENiGMA½ shares a socket *server*, not a descriptor, so `DOOR32.SYS` line 2 is written as `-1` and bivrost! replaces both lines with the real handle. A door handed `2` and `-1` with nothing in between is entitled to refuse to start, and some do.
:::

Doors that ignore these fields entirely — most DOS-era games under an emulator — are unaffected by any of this.

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
* [Local Doors](local-doors.md)
* [External DOS Emulators](local-doors-dos-emulation.md)
* [Native v86 Emulation](local-doors-v86.md)
* [Telnet Bridge](telnet-bridge.md)

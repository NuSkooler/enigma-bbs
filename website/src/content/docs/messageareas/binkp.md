---
title: BinkP Native Mailer
description: "The built-in BinkP mailer: inbound listener, outbound caller, CRAM-MD5, NR mode and GZ compression."
sidebar:
    order: 5
---
ENiGMA½ includes a built-in [BinkP](http://ftsc.org/docs/fts-1026.001) mailer that handles both inbound and outbound FidoNet packet transport without requiring an external daemon such as `binkd`.

BinkP is the TCP/IP session-layer protocol used by modern FidoNet nodes to exchange mail packets and files. The native mailer implements:

- **Inbound server** — listens for incoming BinkP connections (default port 24554)
- **Outbound caller** — dials configured nodes to deliver pending mail
- **Crashmail** — sub-second send-on-export, no scheduled wait
- **Pull cycle** — periodic dial of every configured peer to keep echo mail flowing in from quiet hubs
- **CRAM-MD5 authentication** ([FTS-1027](http://ftsc.org/docs/fts-1027.001))
- **NR (Non-Reliable) mode** ([FTS-1028](http://ftsc.org/docs/fts-1028.001)) — safe resume after disconnect
- **TLS / binkps** — optional encrypted listener (port 24555) and TLS outbound per node
- **GZ compression** ([FTS-1029](http://ftsc.org/docs/fts-1029.001)) — transparent per-file compression negotiated via `EXTCMD`; skips already-compressed types
- **Multi-batch sessions** — continues exchanging files across multiple EOB cycles in a single TCP connection
- **FREQ (File REQuest)** — serves files to requesting nodes; supports magic names (e.g. `NODELIST`) and versioned directory search
- **BSO spool integration** — reads and writes the same BSO outbound/inbound directories that [`ftn_bso`](bso-import-export.md) uses for packet scanning and tossing

:::note
The native BinkP mailer handles **transport only**. Scanning outbound messages into packets and tossing received packets into message areas is still performed by the `ftn_bso` scanner/tosser. These two modules work together automatically.
:::

:::note
If you prefer to continue using an external mailer such as [binkd](https://github.com/pgul/binkd), `ftn_bso` continues to work unchanged — the native BinkP mailer is purely opt-in.
:::

---

## Configuration

All BinkP configuration lives inside the existing `scannerTossers.ftn_bso` block in `config.hjson`, under a `binkp` sub-key.

```hjson
scannerTossers: {
    ftn_bso: {
        // ... existing ftn_bso config (paths, nodes, schedule, etc.) ...

        binkp: {
            // Inbound server — accepts connections from other nodes
            inbound: {
                enabled: true
                port: 24554        // IANA-registered BinkP port
                address: "0.0.0.0" // listen on all interfaces; use "127.0.0.1" for local-only

                // Optional TLS listener (binkps, port 24555). Both plain and TLS
                // listeners run simultaneously when enabled.
                // tls: {
                //     enabled: true
                //     port: 24555
                //     certFile: "/path/to/binkp.crt"
                //     keyFile:  "/path/to/binkp.key"
                // }
            }

            // Pull cycle: dial every configured peer on this schedule, even
            // if we have no outbound for them. Keeps echo mail flowing in
            // from quiet hubs that wait for the spoke (us) to call.
            // Set to null/empty to disable; crashmail still works.
            pullSchedule: "every 15 minutes"

            // Crashmail debounce window (ms). When ftn_bso queues outbound
            // mail, dialing is delayed this long so back-to-back exports to
            // the same peer coalesce into a single session.
            crashmailDebounceMs: 500

            // FREQ (File REQuest) — serve files to requesting nodes.
            // When a remote node sends a .req file, ENiGMA resolves each
            // requested name and sends the files back in the same session.
            // Resolution order: magic → areas (file base) → dirs
            //
            // freq: {
            //     enabled: true
            //
            //     // magic — name → path or glob; newest glob match wins
            //     // magic: {
            //     //     NODELIST: "/path/to/nl/NODELIST.*"
            //     //     ALLFIX:   "/path/to/ALLFIX.NA"
            //     // }
            //
            //     // areas — file base area tags (best for TIC-imported files)
            //     // areas: [
            //     //     { areaTag: "nodelists" }
            //     // ]
            //
            //     // dirs — raw filesystem directories
            //     // dirs: [ "/path/to/freq-files" ]
            //
            //     maxFiles:   10    // cap on files returned per session (default 10)
            //     requirePwd: false // if true, only honour FREQs from password-authenticated sessions
            // }

            // Per-node outbound configuration
            nodes: {
                // Key is an FTN address (wildcards supported, e.g. "21:1/*")
                "1:218/700": {
                    host: "bbs.example.com"
                    port: 24554              // optional, defaults to 24554
                    sessionPassword: "s3cr3t" // optional CRAM-MD5 password — see tip below
                    pull: true                // optional, defaults to true
                    // requestNR: true        // optional; ask this node to send in NR mode
                    // gz: false              // optional; disable GZ compression for this node
                }

                // TLS outbound example (binkps):
                // "1:218/701": {
                //     host: "secure.example.com"
                //     port: 24555
                //     sessionPassword: "s3cr3t"
                //     tls: true
                //     tlsAllowSelfSigned: true   // or tlsFingerprint / tlsCertFile
                // }
            }
        }
    }
}
```

:::tip
Avoid storing `sessionPassword` in plain text. Use `@file:` or `@environment:` instead:
```hjson
sessionPassword: "@file:/run/secrets/binkp_pass"
```
See [Configuration Files — Secret Files](../configuration/config-files.md#secret-files) for details.
:::

### `binkp.inbound`

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `enabled` | No | `false` | Start the inbound listening server on startup |
| `port` | No | `24554` | TCP port to listen on |
| `address` | No | `"0.0.0.0"` | IP address to bind |

### `binkp.pullSchedule`

[Later.js text expression](https://bunkat.github.io/later/parsers.html#text) — for example `"every 15 minutes"` or `"at 3:00 am"`. When the timer fires, ENiGMA½ dials **every** configured peer in `binkp.nodes` (excluding wildcard patterns and any peer with `pull: false`). This is independent of whether we have outbound mail queued — its job is to give quiet hubs a chance to push their pending echo mail down to us.

Set to `null` or `""` to disable the pull cycle. Leaving the key out does not disable it: the default, `"every 15 minutes"`, applies. Crashmail (event-driven dialing on outbound) still works without it.

If the expression fails to parse, the pull cycle is disabled and a warning is logged at startup.

### `binkp.crashmailDebounceMs`

When `ftn_bso` writes a flow file (i.e. queues a packet for a remote peer), it emits a `NewOutboundBSO` event. The BinkP module dials the destination peer right away — within hundreds of milliseconds — so messages ship without waiting on the next pull cycle. To avoid one session per message during a multi-message export, dialing is delayed by `crashmailDebounceMs` (default `500`) so back-to-back exports to the same peer coalesce into a single session.

Lower it to ship faster at the cost of more sessions per burst; raise it if your scanner emits big batched exports.

### `binkp.staleLockMaxAgeMs`

When ENiGMA½ acquires a node lock (`.bsy` file in the outbound directory), it expects to release it cleanly at session end. If the BBS crashes mid-session the lock persists and that node becomes un-pollable until the file is removed.

`staleLockMaxAgeMs` (default `30 * 60 * 1000`, i.e. 30 minutes) controls how long a `.bsy` file may live untouched before it's reaped. Two paths use it:

- **Startup sweep** runs unconditionally on BinkP module startup (even when inbound is disabled, since outbound calls also acquire locks).
- **Just-in-time check** runs when taking a lock finds one already there.

The default is 6× the internal session timeout (5 minutes), giving a generous safety margin without making post-crash recovery slow. If you ever raise the session timeout, raise this in proportion.

ENiGMA½ refreshes every `.bsy` it holds once a minute (more often if `staleLockMaxAgeMs` is under 5 minutes), as binkd does, so a long session's lock never looks stale to anyone. It does so by writing the lock's own line back over itself, so the file's modification time is the one the filesystem assigns (on a network filesystem, the file server's clock). Its own locks hold one line, the process ID first (FTS-5005.003 §5.1):

```
1275201 ENiGMA 3f9a1c0b7d2e 9c4e1a7b2f60d8e1
```

The second field identifies the machine's current boot and PID namespace (as a short hash, or `-` where it cannot be read, such as on non-Linux systems); the third is new for every lock taken. A lock in this form is removed:

- at once, when it was written on this machine (same boot, same PID namespace) by a process that is no longer running. A crash or `SIGKILL` therefore leaves nothing behind on restart.
- after 5 minutes without being refreshed (or `staleLockMaxAgeMs`, if that is shorter): its process stopped refreshing it. This covers a container restarted after a crash (each start has a new PID namespace) and other machines sharing the outbound.

A lock's age is its modification time compared with the clock of whoever is looking at it. **Machines sharing an outbound (and the file server, for a network filesystem) need their clocks within a few minutes of each other**; use NTP. A clock running more than about 4 minutes ahead of the file server can take a live ENiGMA½ lock for an orphaned one.

Any other `.bsy` (binkd's, other software's, an older ENiGMA½'s) is removed only once it is older than `staleLockMaxAgeMs`, never because of the PID in it.

When ENiGMA½ releases a lock it removes the file only if it still holds what it wrote: a lock another program took in the meantime stays. If a lock it holds is removed or replaced while a session is running, or cannot be refreshed for half the 5 minutes, ENiGMA½ logs a warning and stops relying on it: for the rest of the session it neither changes the flow files that lock covers nor deletes or truncates the files it sends from them. Those files stay where they are, still queued, and are sent again next session. On shutdown, live sessions are sent `M_BSY` ("Shutting down") and closed, and their locks released, within 4 seconds; anything still held when the process exits is removed as it exits (only if it still holds ENiGMA½'s own line).

The same `.bsy` files are honoured by external mailers such as Binkd, and by the ENiGMA½ *tosser* when it queues outbound — see [`flowLockTimeoutMs`](#flowlocktimeoutms) below.

### Busy nodes

A session holds the `.bsy` lock of every address it carries mail for, from before it reads any flow file until after the last flow file it changed has been written (or, if a write is stuck, for at most 30 seconds after the session ends; a line not yet marked by then is sent again next session). For each address that is every `.bsy` covering its flow files: the one in its own outbound directory, and the one beside its flow files in any other existing outbound directory ENiGMA½ reads for it (a pre-0.5.1-beta directory still draining, a second network in the same zone, a point directory, under whichever case it is spelled on disk). A flow file that appears in another directory during the session waits for the next one.

When a node calls in, it presents its addresses (AKAs), and ENiGMA½ locks each one, as [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §5.1 asks, before it answers the caller's password. It creates no directory to do so: a directory that does not exist holds no mail for the address. Up to 128 addresses from one caller are locked and served; any beyond that are ignored, with a warning. An address that is already locked (another session with that node, from ENiGMA½ or from another mailer sharing the outbound) is handled the way binkd handles it:

- If a session password is configured for that address, the whole session is busy: ENiGMA½ answers `M_BSY` "Secure AKA *address* busy" instead of accepting the password, and nothing is sent or received. Another session for that system is already running.
- Otherwise the address is dropped for this session: nothing is read, sent or marked for it, and the caller's other addresses are served as usual.
- If every address is busy, the session is answered `M_BSY` "All AKAs are busy", again instead of accepting the password.

When ENiGMA½ calls a node it locks that node (as above) before dialling and skips it if it is busy.

### Poll requests

A zero-length flow file is a poll request ([FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §3.2, §3.4): call this node even though nothing is queued for it. It is how a sysop asks for a call by hand (`touch 00010002.clo`) and how other software sharing the outbound asks for one. A zero-length `.ilo`, `.clo`, `.dlo`, `.flo`, `.iut`, `.cut`, `.dut` or `.out` makes the node due a call the next time ENiGMA½ polls: the pull cycle, the `binkpPullNow` task, or crashmail. The node still needs a `host` in `binkp.nodes` to be dialled; without one, the poll waits until the node calls in.

The file is removed once a session with that node ends successfully, whichever side started it: a call ENiGMA½ made, or the node calling in and authenticating for that address. ENiGMA½ removes it while it still holds the node's `.bsy` lock, and only if it is still a zero-length file; one that has had mail queued into it during the session is kept and read as a normal flow file next session. A session that drops, ends in an error or is refused with `M_BSY` leaves it in place, as §3.4 asks, so the node is called again. If another mailer sharing the outbound answers the poll first, it removes the file and ENiGMA½ has nothing to do.

Hold (`.hlo`, `.hut`) means wait for the node to call us, so an empty hold file is neither a reason to dial nor removed. A flow file that is a symlink is not a poll request even when the file it leads to is empty. `oputil bso status` shows nodes with a poll request in its `Poll` column, and `oputil bso list` shows the file as `POLL`.

### Flow file lines

ENiGMA½ reads each line of a flow file the way [FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §3.1 and the other mailers that share an outbound read it:

| Line starts with | Meaning |
|---|---|
| `^` or `-` | send, then delete the file |
| `#` | send, then truncate the file |
| `@`, or no directive | send and keep the file |
| `~`, or its alternate `!` | skip: already processed (sent) |

Leading and trailing whitespace is ignored, and so is a UTF-8 byte order mark at the start of the file (it is written back as it was). A path is normally absolute; a relative path (one not starting with `/`, such as `name.pkt` or `sub/name.pkt`) is taken relative to the flow file's own directory, never ENiGMA½'s working directory. That applies to `~` and `!` lines too, when ENiGMA½ needs to know what one referred to. A line that starts with any other punctuation, contains a control character, is longer than 4096 bytes, or has a directive and no path is never sent and never pruned, and the flow file is kept while it is there. ENiGMA½ logs a warning about it at most once an hour per flow file, and `oputil bso list` shows it as `UNKNOWN` or `INVALID`. A path whose bytes are not UTF-8 (one written in CP437 or latin1 by DOS-era software, say) is not sent either, and is listed as `INVALID` while the file is there.

When ENiGMA½ marks a line sent, or removes one, it writes a new copy of the flow file beside it and renames it into place (for a flow file that is a symlink, beside the file the link leads to, keeping the link), so nothing reading the flow file at that moment sees it half written. Every line it did not change goes back exactly as it was: other software's bytes, CRLF or LF endings, and blank lines. The copy keeps the original's permissions and group. A flow file that belongs to another user (a separate mailer running as its own user, in a group-shared outbound) is not replaced, since that would make it ENiGMA½'s and could lock the other mailer out of it; it is changed in place instead, marking a `^`, `#`, `-` or `@` line by overwriting its first character with `~` as binkd does. Temporary copies are named `.enigma-flow-*.tmp`; one left behind by a crash is removed at startup once it is older than [`staleLockMaxAgeMs`](#binkpstalelockmaxagems).

A flow file is removed only after ENiGMA½ has marked or removed a line in it and nothing is left to send, that is, every remaining line is blank or starts with `~` or `!`. A flow file holding only such lines that ENiGMA½ did not just change is left alone. So is a zero-length flow file (a poll request; see [Poll requests](#poll-requests)): marking lines in other flow files never removes it. If the flow file cannot be removed (a directory ENiGMA½ may not delete files in), it is written with the lines marked instead, so nothing already sent goes again. For a flow file that is a symlink, ENiGMA½ removes only the link, and writes the file it leads to with the lines marked; that file is never removed. A flow file that is a link into ENiGMA½'s configuration, security, database or log directories (see [`flowDispositionRoots`](#binkpflowdispositionroots)) is not read or changed at all: nothing is sent from it, it does not make the node due for a poll, a warning is logged at most once an hour, and `oputil bso list` shows it as `REFUSED` with the file it leads to. While it is there, the TIC passthrough transit sweep removes nothing, since it cannot tell what that flow file still names.

### `binkp.flowRefWarnRepeatMs`

A BSO flow file stores an **absolute path** to each file queued for a node. If that file is later deleted or moved, the entry can never be sent — the node simply never receives it. ENiGMA½ warns about this, naming the node and the file.

`flowRefWarnRepeatMs` (default `60 * 60 * 1000`, i.e. 1 hour) is how often that warning repeats for the same reference. It repeats because the condition is a standing fault rather than an event: nothing fixes it on its own, and saying it once per process meant it scrolled away long before anyone looked.

Raise it if you have a dangling reference you already know about and have not dealt with yet. To see what is affected and act on it, use [`oputil bso status`](../admin/oputil.md) — and note that a node whose queued entries have *all* gone missing is deliberately not polled, so that command is the only place it shows up.

### `binkp.flowDispositionRoots`

A flow file line starting with `^` (or `-`) asks for the file to be deleted once it is sent, and `#` asks for it to be truncated. ENiGMA½ carries that out only for files inside the **mail directories**:

- every outbound directory it scans for flow files (`outbound/`, per-network directories, zone directories such as `outbound.002/`, and point directories under them);
- `paths.inbound`, `paths.secInbound` and `paths.ticTransit`;
- any directory listed in `flowDispositionRoots` (default `[]`).

A file elsewhere is still sent, but left in place, and the line is marked sent as usual. ENiGMA½ logs a warning naming the node and the file, at most once an hour per flow file, and `oputil bso list` shows the entry as `KEPT`.

Everything ENiGMA½ queues itself (packets, bundles, generated `.tic` files) is in the outbound, so nothing needs listing for that. List a directory when other software sharing the outbound queues files from it that should be removed after sending, for example a separate tosser's inbound:

```hjson
binkp: {
    flowDispositionRoots: [ "/var/spool/husky/inbound" ]
}
```

Symlinks: a delete removes the link itself, never the file it points to, so a `^` symlink inside a mail directory is removed once sent. A truncate never goes through a symlink: a `#` line whose file is a symlink is sent and marked sent, but nothing is truncated, and the log says why.

ENiGMA½'s own configuration, security, database and log directories (`paths.config`, `paths.security`, `paths.db`, `paths.modsDb`, `paths.logs`) and the directory holding the loaded `config.hjson` are **never** sent from a flow file or as a direct-attach netmail file, nor disposed in, whether listed here or not (a symlink is judged by the file it points to). A flow file entry naming a file there is skipped, logged as a warning when first seen and then at most once an hour, left in the flow file, shown by `oputil bso list` as `REFUSED`, and does not make the node due for a poll. If a mail directory itself lies inside one of these (a `config.hjson` kept at the top of the install, say), the mail directory still works: the more specific directory wins. A file base storage directory there can still be sent from. File requests (`binkp.freq`) serve only the files and areas you configure for them and are not covered by this list.

When a queued file is gone from its stored path but a file of that name sits beside the flow file, and the entry may not be taken from there (a send-and-keep line, or a stored path whose directory is not named like an outbound), it is not sent. The log says the file is beside the flow file, and `oputil bso list` shows it as `MISFILED`; `oputil bso prune` never removes it. Fix the path in the flow file or move the file back.

### `flowLockTimeoutMs`

:::note
This one lives at `scannerTossers.ftn_bso.flowLockTimeoutMs`, **not** under `binkp` — it governs the tosser (the writer), not the mailer.
:::

[FTS-5005.003](http://ftsc.org/docs/fts-5005.003) §5.1 requires that *any* software touching a BSO flow file first take that file's `.bsy` lock, and prohibits changes entirely while the lock is held:

> A bsy is a main control file that must be used by any software dealing with flow files in BSO. […] Any software must check this file before doing any changes in flow files. If a bsy file exists all changes are prohibited in any corresponding flow files.

That applies to ENiGMA½ queueing outbound just as much as to a mailer sending it. Because the lock is a standard, per-node `NNNNnnnn.bsy` in the node's own outbound directory, honouring it interlocks correctly with the **native BinkP mailer and external mailers alike** — Binkd takes the very same lock, so neither side needs to know about the other.

`flowLockTimeoutMs` (default `5000`, i.e. 5 seconds) is how long the tosser waits for a busy node's lock before giving up. Contention is normally momentary — a session finishing an entry — but the lock is held for the length of a whole session, and during that time the spec says the flow file must not be modified.

If the wait expires the outbound is **not** queued this pass, and you'll see:

```
Flow file busy; outbound not queued this pass
```

Nothing is lost or corrupted — the write simply did not happen, which is what the spec requires. Raise this on a busy hub with long sessions.

### `binkp.inboundTempMaxAgeMs`

Inbound files are buffered in `tempDir` (defaults to the OS temp dir) under names like `binkp_in_*.dt`, then renamed into the inbound spool on successful receipt. Two layers protect against leaks if a peer drops mid-transfer:

- **In-session finalizer**: each session tracks the temp files it owns; on socket error or disconnect they are unlinked immediately.
- **Startup sweep**: catches anything left after a hard process kill that prevented the in-session finalizer from running. `inboundTempMaxAgeMs` (default `60 * 60 * 1000`, i.e. 1 hour) is the age threshold.

### `binkp.nodes`

Each key is an FTN address or wildcard pattern. Values:

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `host` | Yes (for outbound) | — | Hostname or IP of the remote node |
| `port` | No | `24554` | Remote port |
| `sessionPassword` | No | — | Session password for CRAM-MD5 authentication (distinct from FTN packet password) |
| `pull` | No | `true` | Include this node in the periodic pull cycle. Set `false` for write-only peers. **Crashmail dispatch is unaffected** — outbound queued for a `pull: false` peer still triggers an immediate session. |
| `requestNR` | No | `false` | Ask this node to send files to us in NR mode. See below. |
| `gz` | No | `true` | Set `false` to neither offer nor use GZ compression with this node. |

Wildcard patterns (e.g. `"21:1/*"`) are valid for inbound password lookup but are skipped during pull cycles, since the pull cycle dials concrete addresses only. Put the most specific patterns first in your config — pattern matching uses first-match-wins on insertion order.

### `binkp.nodes[].requestNR` — NR (non-reliable) mode

NR mode is the binkp answer to a link that keeps dropping mid-transfer. Normally a sender starts every file at offset 0 and the receiver has to interrupt with `M_GET` to move it; on a bad line the connection is often gone again before that lands. In NR mode the sender instead offers the file with an offset of `-1` and waits to be told where to start, so the resume position is settled before any data moves. See [FTS-1028](http://ftsc.org/docs/fts-1028.001).

`OPT NR` is a request aimed at the *remote*: it asks the other side to send **to us** that way. It costs a round trip per file, and the standard is blunt that it "degrades performance over regular quality connections and it should be used only if absolutely necessary" — so ENiGMA½ does not send it unless a node opts in with `requestNR: true`. binkd behaves the same way, asking only when the sysop sets `-nr` or `-nd` on a node.

The other direction needs no configuration. If a peer asks us for NR mode we always honour it, which FTS-1028 makes a `MUST`.

### `binkp.nodes[].gz` — compression

When both sides advertise `GZ` (and `EXTCMD`), file data is compressed on the wire. Files that are already compressed — ArcMail bundles (`.mo0`, `.tu1`, …), `.zip`, `.arj` and friends — are sent as-is, so a node using `archiveType` sees little of this either way.

The wire format is the zlib container ([FTS-1029](http://ftsc.org/docs/fts-1029.001)), which is what binkd, Mystic and the rest expect. Inbound data is decoded from either the zlib or the gzip container, so a peer running an ENiGMA½ older than 0.5.1-beta — which sent gzip — is still understood.

If a peer cannot decompress what we send, ENiGMA½ does not simply give up on the file: FTS-1029 allows a receiver to ask for it again uncompressed, and a peer that asks us that way is honoured for the rest of the session. Set `gz: false` to skip compression with a node entirely.

### `binkp.nodes[].tls` / TLS outbound (binkps)

To dial a node over TLS (binkps, typically port 24555) set `tls: true` in the node block. Exactly one of the following trust options is also required:

| Key | Description |
|-----|-------------|
| `tlsAllowSelfSigned` | `true` — accept any certificate (convenient, no MITM protection) |
| `tlsFingerprint` | `"SHA256:AA:BB:..."` — pin to a specific certificate fingerprint |
| `tlsCertFile` | `"/path/to/ca.pem"` — trust a specific CA or self-signed certificate file |

### `binkp.inbound.tls` — TLS listener (binkps)

Set `inbound.tls.enabled: true` to start a second, TLS-only listener. Both the plain (port 24554) and TLS (default 24555) listeners run simultaneously. Requires a certificate and matching private key:

| Key | Description |
|-----|-------------|
| `enabled` | `true` to start the TLS listener |
| `port` | Port to listen on (default `24555`) |
| `certFile` | Absolute path to the PEM certificate |
| `keyFile` | Absolute path to the PEM private key |

### `binkp.freq` — File REQuest (FREQ)

When FREQ is configured, remote nodes can request named files by sending a `.req` file containing one name per line. ENiGMA½ resolves each name and sends the matching files back **in the same BinkP session** (no extra round-trip required).

Passwords in `.req` files (e.g. `NODELIST!password`) are stripped and ignored.

**Resolution order** (first match wins):

1. **`magic`** — case-insensitive name → path mapping. The path may contain glob wildcards (`*`, `?`); when it does, ENiGMA½ expands the glob at request time and returns the newest matching file. This means `NODELIST: "/path/to/nl/NODELIST.*"` always serves the current segment without any config changes after each weekly update.

2. **`areas`** — ENiGMA½ file base area tags. This is the preferred option when files arrive via TIC file echoes: TIC processing imports each received file into a configured file area, and the FREQ resolver queries that area by name (exact match first, then prefix — e.g. `NODELIST` matches `NODELIST.365`). The newest file by upload timestamp wins.

3. **`dirs`** — plain filesystem directories. Useful for files managed outside the file base. Exact name match first, then prefix match; newest by filesystem mtime wins.

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable FREQ handling |
| `magic` | — | Object mapping magic names → file paths or glob patterns |
| `areas` | `[]` | Array of `{ areaTag }` objects — file base areas to search |
| `dirs` | `[]` | Array of directory paths to search |
| `maxFiles` | `10` | Maximum files returned per session (across all resolvers combined) |
| `requirePwd` | `false` | When `true`, only honour FREQs from sessions authenticated with a `sessionPassword` (CRAM-MD5) |

**Typical setup for a TIC-fed nodelist:**

```hjson
// In scannerTossers.ftn_bso.ticAreas — map the hub's TIC area to a local file area
ticAreas: {
    fidonet_nodelist: {
        areaTag: "nodelists"
        storageTag: "nodelists"
    }
}

// In fileBase — define the storage tag and area
// fileBase.storageTags: { nodelists: "nodelists" }
// fileBase.areas: { nodelists: { name: "Nodelists", storageTags: ["nodelists"] } }

// In binkp — point FREQ at the same area
freq: {
    enabled: true
    areas: [
        { areaTag: "nodelists" }
    ]
}
```

With this setup, every new nodelist that arrives via TIC is immediately FREQ-serveable — no path configuration to maintain.

### Sessions and batches

A binkp/1.1 session is a series of *batches*. Each ends when both sides have sent `M_EOB`, and another follows any batch that carried more than that pair — so a session that moved mail always ends on a short empty batch. Each new batch is also an opportunity: anything that turned up mid-session, such as a FREQ response or mail tossed from a packet that just arrived, goes out on the same connection instead of waiting for the next poll.

Both sides decide this the same way, by counting the command frames sent and received since the batch began, so they agree without negotiating. A peer that identifies itself as binkp/1.0, or that never sends a version at all, is not offered a second batch.

### Reloading configuration

`config.hjson` is watched and reloaded while the BBS runs. Almost everything under `binkp` is read at the moment it is used, so a reload applies on its own:

| Setting | Applies to | When it takes effect |
|---------|-----------|----------------------|
| `nodes` (hosts, ports, passwords, `pull`, TLS) | next session, inbound or outbound | Immediately |
| `freq` | next inbound session | Immediately |
| `crashmailDebounceMs` | next crashmail burst | Immediately |
| `tempDir`, `staleLockMaxAgeMs`, `flowRefWarnRepeatMs`, `flowDispositionRoots` | next session | Immediately |
| `flowLockTimeoutMs` (under `ftn_bso`) | next outbound queue | Immediately |
| `ftn_bso` `paths` and `messageNetworks.ftn.networks` | next session or poll | Immediately |
| `pullSchedule` | the pull timer | On reload — the timer is rebuilt |
| `inbound.enabled`, `inbound.port`, `inbound.address`, `inbound.tls.*` | the listening socket | **Restart required** |

The last row is bound into the socket when it starts listening; changing it under live sessions is not something a reload can do safely. A reload that touches those keys logs a warning naming them so the change isn't silently lost:

```
[BinkP] Inbound listener settings changed; restart required for them to take effect
```

---

## How it works with `ftn_bso`

The two modules share the same BSO spool directories (`paths.outbound`, `paths.inbound`, `paths.secInbound`):

Both resolve outbound subdirectories — which network owns the bare `outbound/` directory, and how zones are suffixed — through the same shared logic, so they cannot disagree about where a given node's mail lives. See [Outbound Directory Layout](bso-import-export.md#outbound-directory-layout).

:::note
Systems upgraded from before 0.5.1-beta may still have mail queued under the previous layout, in which a multi-network system with no explicit `defaultNetwork` wrote the first-listed network's mail to `<networkName>/` rather than `outbound/`. BinkP scans that directory as well, so anything left there is still sent; once it is empty it can be removed. See [UPGRADE.md](https://github.com/NuSkooler/enigma-bbs/blob/master/UPGRADE.md).
:::

**Outbound flow:**
1. `ftn_bso` scans message areas → writes `.pkt` files and flow file references into the outbound spool
2. `ftn_bso` emits a `NewOutboundBSO` event with the destination address
3. The BinkP module receives the event, debounces briefly (`crashmailDebounceMs`), then dials the destination
4. After a successful send, the flow file entry is rewritten as `~`-prefixed and the packet file is deleted (see [`flowDispositionRoots`](#binkpflowdispositionroots) for where that applies); once nothing in a flow file is left to send the flow file itself is removed (see [Flow file lines](#flow-file-lines))
5. Independently, the pull-cycle timer dials every configured peer on `pullSchedule` so quiet hubs get periodic touches even when we have nothing for them (the `binkpPullNow` task runs the same cycle on demand)

**Inbound flow:**
1. A remote node connects on port 24554 (or ENiGMA½ calls out and receives files in return)
2. BinkP receives the files into `tempDir` and on successful completion moves them into `paths.inbound` (or `paths.secInbound` for password-authenticated sessions)
3. `ftn_bso` is immediately triggered to toss the received packets into message areas — no waiting for the next scheduled import

**External mailer compatibility:**
If you use an external mailer (`binkd`, etc.) instead of or alongside the native BinkP mailer, `ftn_bso` continues to toss inbound files via its `@watch` / `@sched` mechanisms unchanged. The native BinkP mailer's immediate-toss trigger is additive and does not interfere.

---

## Pulling now

To run the pull cycle now, run the `binkpPullNow` task from the [WFC's task screen](../modules/wfc.md#tasks) (<kbd>T</kbd> on the WFC dashboard). It dials the same nodes as `pullSchedule`, plus any with mail waiting, and works whether or not a `pullSchedule` is set. `exportOutboundNow` next to it asks `ftn_bso` to export new mail first; anything it queues is dialed by crashmail as usual. See [Event Scheduler: Built-in Events](../configuration/event-scheduler.md#built-in-events).

A custom menu can offer the same thing with the `binkp/binkp_poll_module` module, which runs the pull cycle and reports the result:

```hjson
myBinkpPollMenu: {
    desc: "BinkP Poll"
    module: binkp/binkp_poll_module
}
```

Guard the entry that leads to it with a sysop ACS such as `GM[sysops]` (members of the `sysops` group) or `ID1` (the root user only); the WFC's own default, `SCAF2ID1GM[wfc]`, also requires a secure connection and 2FA. Do not use `SC` alone: it only means a secure connection, so any caller on SSH or TLS would pass. The `!BINKP` main menu command earlier templates had for this never worked and has been removed.

---

## Firewall / NAT notes

- Open TCP port **24554** inbound if you want other nodes to be able to call you
- The outbound caller initiates connections from an ephemeral port; no special firewall rules needed for outbound
- If you are behind NAT, configure your router to forward port 24554 to the BBS host

---

## Migrating from external `binkd`

1. Stop `binkd` and disable its startup service
2. Add the `binkp` block to your `scannerTossers.ftn_bso` config as shown above, with `inbound.enabled: true`
3. Copy your per-node passwords from your `binkd.cfg` into `binkp.nodes` as `sessionPassword` values
4. Remove or adjust any `@watch` / `@sched` import schedule from `ftn_bso` — the native mailer triggers toss immediately after each session, so a frequent scheduled import is no longer necessary (a slow fallback such as `"every 60 minutes"` is harmless)
5. Reload the config (`oputil.js config reload`) or bounce the process

:::caution
Do **not** run the native BinkP mailer and `binkd` concurrently on the same node address. They will compete for the BSO `.bsy` lock files and one will win while the other skips. If you want to run both temporarily for testing, use different node addresses or stagger their poll windows.
:::

### Renamed since `binkd` migration guides

If you're following older notes or examples, two things have changed:

- The `binkp.schedule` key is now **`binkp.pullSchedule`** with clearer semantics: it dials every configured peer regardless of pending mail, not just nodes with queued outbound. Outbound dispatch is now event-driven via crashmail and does not require a schedule.
- There is no separate "outbound poll schedule" key — the pull cycle is the only schedule. Sub-second outbound dispatch happens automatically via crashmail.

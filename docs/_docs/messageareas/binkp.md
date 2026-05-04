---
layout: page
title: BinkP Native Mailer
---
## BinkP Native Mailer

ENiGMA½ includes a built-in [BinkP](http://ftsc.org/docs/fts-1026.001) mailer that handles both inbound and outbound FidoNet packet transport without requiring an external daemon such as `binkd`.

BinkP is the TCP/IP session-layer protocol used by modern FidoNet nodes to exchange mail packets and files. The native mailer implements:

- **Inbound server** — listens for incoming BinkP connections (default port 24554)
- **Outbound caller** — dials configured nodes to deliver pending mail
- **Crashmail** — sub-second send-on-export, no scheduled wait
- **Pull cycle** — periodic dial of every configured peer to keep echo mail flowing in from quiet hubs
- **CRAM-MD5 authentication** ([FTS-1027](http://ftsc.org/docs/fts-1027.001))
- **NR (Non-Reliable) mode** ([FTS-1028](http://ftsc.org/docs/fts-1028.001)) — safe resume after disconnect
- **BSO spool integration** — reads and writes the same BSO outbound/inbound directories that [`ftn_bso`](bso-import-export.md) uses for packet scanning and tossing

> :information_source: The native BinkP mailer handles **transport only**. Scanning outbound messages into packets and tossing received packets into message areas is still performed by the `ftn_bso` scanner/tosser. These two modules work together automatically.

> :information_source: If you prefer to continue using an external mailer such as [binkd](https://github.com/pgul/binkd), `ftn_bso` continues to work unchanged — the native BinkP mailer is purely opt-in.

---

### Configuration

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

            // Per-node outbound configuration
            nodes: {
                // Key is an FTN address (wildcards supported, e.g. "21:1/*")
                "1:218/700": {
                    host: "bbs.example.com"
                    port: 24554              // optional, defaults to 24554
                    sessionPassword: "s3cr3t" // optional CRAM-MD5 password
                    pull: true                // optional, defaults to true
                }
            }
        }
    }
}
```

#### `binkp.inbound`

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `enabled` | No | `false` | Start the inbound listening server on startup |
| `port` | No | `24554` | TCP port to listen on |
| `address` | No | `"0.0.0.0"` | IP address to bind |

#### `binkp.pullSchedule`

[Later.js text expression](https://bunkat.github.io/later/parsers.html#text) — for example `"every 15 minutes"` or `"at 3:00 am"`. When the timer fires, ENiGMA½ dials **every** configured peer in `binkp.nodes` (excluding wildcard patterns and any peer with `pull: false`). This is independent of whether we have outbound mail queued — its job is to give quiet hubs a chance to push their pending echo mail down to us.

Set to `null`, `""`, or omit the key entirely to disable the pull cycle. Crashmail (event-driven dialing on outbound) still works without it.

If the expression fails to parse, the pull cycle is disabled and a warning is logged at startup.

#### `binkp.crashmailDebounceMs`

When `ftn_bso` writes a flow file (i.e. queues a packet for a remote peer), it emits a `NewOutboundBSO` event. The BinkP module dials the destination peer right away — within hundreds of milliseconds — so messages ship without waiting on the next pull cycle. To avoid one session per message during a multi-message export, dialing is delayed by `crashmailDebounceMs` (default `500`) so back-to-back exports to the same peer coalesce into a single session.

Lower it to ship faster at the cost of more sessions per burst; raise it if your scanner emits big batched exports.

#### `binkp.staleLockMaxAgeMs`

When ENiGMA½ acquires a node lock (`.bsy` file in the outbound directory), it expects to release it cleanly at session end. If the BBS crashes mid-session the lock persists and that node becomes un-pollable until the file is removed.

`staleLockMaxAgeMs` (default `30 * 60 * 1000`, i.e. 30 minutes) controls how long a `.bsy` file may live untouched before it's reaped. Two paths use it:

- **Startup sweep** runs unconditionally on BinkP module startup (even when inbound is disabled, since outbound calls also acquire locks).
- **Just-in-time check** runs when `acquireLock` hits an `EEXIST`: if the existing lock is older than the threshold, it's unlinked and the lock is acquired.

The default is 6× the internal session timeout (5 minutes), giving a generous safety margin without making post-crash recovery slow. If you ever raise the session timeout, raise this in proportion.

#### `binkp.inboundTempMaxAgeMs`

Inbound files are buffered in `tempDir` (defaults to the OS temp dir) under names like `binkp_in_*.dt`, then renamed into the inbound spool on successful receipt. Two layers protect against leaks if a peer drops mid-transfer:

- **In-session finalizer**: each session tracks the temp files it owns; on socket error or disconnect they are unlinked immediately.
- **Startup sweep**: catches anything left after a hard process kill that prevented the in-session finalizer from running. `inboundTempMaxAgeMs` (default `60 * 60 * 1000`, i.e. 1 hour) is the age threshold.

#### `binkp.nodes`

Each key is an FTN address or wildcard pattern. Values:

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `host` | Yes (for outbound) | — | Hostname or IP of the remote node |
| `port` | No | `24554` | Remote port |
| `sessionPassword` | No | — | Session password for CRAM-MD5 authentication (distinct from FTN packet password) |
| `pull` | No | `true` | Include this node in the periodic pull cycle. Set `false` for write-only peers. **Crashmail dispatch is unaffected** — outbound queued for a `pull: false` peer still triggers an immediate session. |

Wildcard patterns (e.g. `"21:1/*"`) are valid for inbound password lookup but are skipped during pull cycles, since the pull cycle dials concrete addresses only. Put the most specific patterns first in your config — pattern matching uses first-match-wins on insertion order.

---

### How it works with `ftn_bso`

The two modules share the same BSO spool directories (`paths.outbound`, `paths.inbound`, `paths.secInbound`):

**Outbound flow:**
1. `ftn_bso` scans message areas → writes `.pkt` files and flow file references into the outbound spool
2. `ftn_bso` emits a `NewOutboundBSO` event with the destination address
3. The BinkP module receives the event, debounces briefly (`crashmailDebounceMs`), then dials the destination
4. After a successful send, the flow file entry is rewritten as `~`-prefixed and the packet file is deleted; once every line in a flow file is `~`-prefixed the flow file itself is removed
5. Independently, the pull-cycle timer dials every configured peer on `pullSchedule` so quiet hubs get periodic touches even when we have nothing for them

**Inbound flow:**
1. A remote node connects on port 24554 (or ENiGMA½ calls out and receives files in return)
2. BinkP receives the files into `tempDir` and on successful completion moves them into `paths.inbound` (or `paths.secInbound` for password-authenticated sessions)
3. `ftn_bso` is immediately triggered to toss the received packets into message areas — no waiting for the next scheduled import

**External mailer compatibility:**
If you use an external mailer (`binkd`, etc.) instead of or alongside the native BinkP mailer, `ftn_bso` continues to toss inbound files via its `@watch` / `@sched` mechanisms unchanged. The native BinkP mailer's immediate-toss trigger is additive and does not interfere.

---

### Sysop poll command

Once BinkP is configured, sysops can trigger an immediate outbound poll from the main menu by typing `!BINKP`. The system dials every node that has pending mail and reports the result. The default menu template wires this for the sysop ACS group automatically; a fresh install gets the command for free.

To expose a poll option in a custom menu entry, point it to the `binkp_poll` module:

```hjson
myBinkpPollMenu: {
    desc: "BinkP Poll"
    module: binkp_poll
}
```

Pre-existing custom menus that don't include this entry will need it added manually.

---

### Firewall / NAT notes

- Open TCP port **24554** inbound if you want other nodes to be able to call you
- The outbound caller initiates connections from an ephemeral port; no special firewall rules needed for outbound
- If you are behind NAT, configure your router to forward port 24554 to the BBS host

---

### Migrating from external `binkd`

1. Stop `binkd` and disable its startup service
2. Add the `binkp` block to your `scannerTossers.ftn_bso` config as shown above, with `inbound.enabled: true`
3. Copy your per-node passwords from your `binkd.cfg` into `binkp.nodes` as `sessionPassword` values
4. Remove or adjust any `@watch` / `@sched` import schedule from `ftn_bso` — the native mailer triggers toss immediately after each session, so a frequent scheduled import is no longer necessary (a slow fallback such as `"every 60 minutes"` is harmless)
5. Reload the config (`oputil.js config reload`) or bounce the process

> :warning: Do **not** run the native BinkP mailer and `binkd` concurrently on the same node address. They will compete for the BSO `.bsy` lock files and one will win while the other skips. If you want to run both temporarily for testing, use different node addresses or stagger their poll windows.

#### Renamed since `binkd` migration guides

If you're following older notes or examples, two things have changed:

- The `binkp.schedule` key is now **`binkp.pullSchedule`** with clearer semantics: it dials every configured peer regardless of pending mail, not just nodes with queued outbound. Outbound dispatch is now event-driven via crashmail and does not require a schedule.
- There is no separate "outbound poll schedule" key — the pull cycle is the only schedule. Sub-second outbound dispatch happens automatically via crashmail.

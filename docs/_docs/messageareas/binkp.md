---
layout: page
title: BinkP Native Mailer
---
## BinkP Native Mailer

ENiGMA½ includes a built-in [BinkP](http://ftsc.org/docs/fts-1026.001) mailer that handles both inbound and outbound FidoNet packet transport without requiring an external daemon such as binkd.

BinkP is the TCP/IP session-layer protocol used by modern FidoNet nodes to exchange mail packets and files. The native mailer implements:

- **Inbound server** — listens for incoming BinkP connections (default port 24554)
- **Outbound caller** — dials configured nodes to deliver pending mail
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

            // Outbound poll schedule (Later.js text syntax)
            // Uncomment to enable automatic outbound polling:
            // schedule: "every 15 minutes"

            // Per-node outbound configuration
            nodes: {
                // Key is an FTN address (wildcards supported, e.g. "21:1/*")
                "1:218/700": {
                    host: "bbs.example.com"
                    port: 24554             // optional, defaults to 24554
                    sessionPassword: "s3cr3t"  // optional CRAM-MD5 / plaintext password
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

#### `binkp.schedule`

Uses [Later.js text syntax](https://bunkat.github.io/later/parsers.html#text) — for example `"every 15 minutes"` or `"at 3:00 am"`. When the schedule fires, ENiGMA½ scans the outbound BSO spool for any nodes with pending mail and calls each one in sequence.

#### `binkp.nodes`

Each key is an FTN address or wildcard pattern. Values:

| Key | Required | Description |
|-----|----------|-------------|
| `host` | Yes (for outbound) | Hostname or IP of the remote node |
| `port` | No | Remote port, defaults to `24554` |
| `sessionPassword` | No | Session password for CRAM-MD5 authentication |

---

### How it works with ftn_bso

The two modules share the same BSO spool directories (`paths.outbound`, `paths.inbound`, `paths.secInbound`):

**Outbound flow:**
1. `ftn_bso` scans message areas on its schedule → writes `.pkt` files and flow files into the outbound spool
2. BinkP polls configured nodes → reads those flow files → connects to each remote → sends the packets
3. After a successful send, the flow file entry is marked sent and the packet file is deleted

**Inbound flow:**
1. A remote node connects on port 24554 (or ENiGMA½ calls out and receives files in return)
2. BinkP receives the files and moves them into `paths.inbound` (or `paths.secInbound` for password-authenticated sessions)
3. `ftn_bso` is immediately triggered to toss the received packets into message areas — no waiting for the next scheduled import

**External mailer compatibility:**
If you use an external mailer (binkd, etc.) instead of or alongside the native BinkP mailer, `ftn_bso` continues to toss inbound files via its `@watch` / `@sched` mechanisms unchanged. The native BinkP mailer's immediate-toss trigger is additive and does not interfere.

---

### Sysop poll command

Once BinkP is configured, sysops can trigger an immediate outbound poll from the main menu by typing `!BINKP` (requires ACS `SU`). The system will connect to all nodes that have pending mail and report the result.

To expose a poll option in a custom menu entry, point it to the `binkp_poll` module:

```hjson
myBinkpPollMenu: {
    desc: "BinkP Poll"
    module: binkp_poll
}
```

---

### Firewall / NAT notes

- Open TCP port **24554** inbound if you want other nodes to be able to call you
- The outbound caller initiates connections from an ephemeral port; no special firewall rules needed for outbound
- If you are behind NAT, configure your router to forward port 24554 to the BBS host

---

### Migrating from external binkd

1. Stop binkd and disable its startup service
2. Add the `binkp` block to your `scannerTossers.ftn_bso` config as shown above, with `inbound.enabled: true`
3. Copy your per-node passwords from your binkd `binkd.cfg` into `binkp.nodes` as `sessionPassword` values
4. Remove or adjust the `@watch` / `@sched` import schedule from `ftn_bso` — the native mailer now triggers toss immediately after each session, so a very frequent scheduled import is no longer necessary (keeping a slow fallback schedule such as `"every 60 minutes"` is harmless)
5. Reload the config (`oputil.js config reload` or bounce the process)

> :warning: Do **not** run the native BinkP mailer and binkd concurrently on the same node address. They will compete for the BSO `.bsy` lock files and one will win while the other skips. If you want to run both temporarily for testing, use different node addresses or stagger their poll windows.

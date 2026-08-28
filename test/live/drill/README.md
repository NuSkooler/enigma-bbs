# FTN drill

Drives automatic message area creation against a **real running ENiGMA½
instance** — `./main.js`, the real scheduler, the real configuration watcher,
real packets through the real tosser.

```bash
./test/live/drill/run.sh [drillDir] [path/to/menu.hjson]
```

It builds a throwaway configuration tree (its own databases, log, mail spool,
and only telnet on port 9888), starts a real instance against it, and leaves
the tree behind for inspection. **It does not touch your own configuration or
data.**

## Why this exists alongside the tests

`test/live/ftn_auto_area.live.js` covers the same ground in-process and much
faster. Three things it cannot cover, because it constructs the module itself:

- **The configuration watcher.** The in-process test loads config with
  `hotReload: false`. Only here does the `sane` watcher actually see the
  generated file being renamed into place, which is how you find out whether
  an atomic rename registers as a change on your platform.
- **The scheduler.** Imports here are triggered the way a board triggers them
  — through the `@watch:` file — rather than by calling `performImport()`.
- **`@immediate` export.** This is how the bug fixed in `6417ed75` was found:
  the rescan netmail was stored with a bare `message.persist()`, which never
  records it with the message network modules, so `@immediate` never fired.
  The outbound spool stayed empty while the log said the request was queued.
  Nothing in-process noticed, because the test called `performExport()`
  directly.

## The mock uplink

`robot.js` reads the request the board **actually sent** out of the outbound
spool, extracts the area tags from it the way a conference manager would, and
answers in a chosen dialect:

| style | shape | from |
|---|---|---|
| `husky` | ` TAG ....... added` | `areafix.c`, dot fill |
| `sbbsecho` | `TAG added.` | bare, trailing period |
| `crashmail` | `+TAG<pad>Attached` | `%-30s STATUS`, command echoed |
| `rescanned` | `TAG rescanned and 42 messages exported.` | variable tail, prefix matched |
| `unknown` | ` TAG ....... wibbled sideways` | nothing says this |

The last row is the point of the exercise: an unrecognized reply must be
reported with its raw line rather than guessed at.

**This cannot tell you how Mystic words its replies.** Nothing local can. It
tells you the loop works end to end against a running board, and which
dialects the parser understands.

## What a good run looks like

```
== EchoMail arrives for areas that are not configured
  [info] Refused to automatically create "TST_NOISY": in the network ignore list
  [info] Automatically created 2 message area(s) for "testnet"
  [info] Packet drill001.pkt imported with 3 new message(s), 1 message(s) skipped (unknown area)

== The rescan request left the building
  outbound/23ae1f2a.pkt
  outbound/00010064.clo
  [info] Queued AreaFix rescan request for 2 area(s)
  [info] Message exported

== A mock uplink answers, in each tosser's dialect
  [info] AreaFix reply for "TST_HUSKX": added
  [info] AreaFix reply for "TST_SBBSX": added
  [info] AreaFix reply for "TST_CRASX": added
  [info] AreaFix reply for "TST_RESCX": rescanned
  [warn] AreaFix reply for "TST_UNKNX" was not understood "TST_UNKNX ... wibbled sideways"
```

One `skipped (unknown area)` is expected and correct — `TST_NOISY` is in the
drill's `ignore` list, so no area is created for it and its message is not
imported.

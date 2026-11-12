# Terminal harness

A scripted telnet caller for ENiGMA. It connects to a **throwaway local
instance**, negotiates a terminal of any size (NAWS + TTYPE), answers cursor
position queries, renders what the caller would see into a
[pyte](https://github.com/selectel/pyte) screen, and writes a text dump of the
screen after each step of a "walk". It also records every absolute cursor move
that lands outside the screen, which is how you spot views placed off a small
terminal. Origin: narrow-terminal work (#991); intended for reuse with
PETSCII/ATASCII work (#593).

**Only ever point this at a throwaway local instance.** The walks log in, post
messages and create users. The client refuses any host other than
`127.0.0.1`/`localhost`/`::1` unless you pass `--allow-remote`; do not. The instance
builder refuses to write into a non-empty directory it did not create (it
looks for a `.term_harness_instance` marker), so it cannot clobber a real
config.

## Setup

Needs `python3`, and `node` (as for ENiGMA itself) with `npm ci` done in the repo.
pyte is not vendored:

    pip install --target dev_util/term_harness/.work/pylib -r dev_util/term_harness/requirements.txt

(or use a venv). `.work/pylib` is found automatically if it exists. Everything
generated lives in `dev_util/term_harness/.work/`, which is git-ignored.

## Build and start an instance

    node dev_util/term_harness/make_instance.js [instanceDir] [port] [secondPort [secondFirstMenu]]
    dev_util/term_harness/run_instance.sh start [instanceDir]

Defaults: `.work/instance`, port `47991`, telnet on 127.0.0.1 only; SSH, web
and WebSocket servers are off. With `secondPort`, a second telnet listener
named `second` is added on that port (`loginServers.telnet.listeners`); it
enters `secondFirstMenu`, default `login` (the login prompt, not the
CONNECT/matrix chain), so `--port` picks which one a walk lands on. Stock menus, one message area, one file area.
Logs are in `<instanceDir>/logs`, process output in `<instanceDir>/enigma.out`.
`run_instance.sh status` and `stop` do what they say. Re-running
`make_instance.js` on its own directory rewrites config and menus but keeps the
user database, so for a clean slate stop the instance and delete `.work/instance`.

### PETSCII starter instance

    node dev_util/term_harness/make_instance.js .work/pet 48901 48902 petsciiConnected --petscii --second-emulation=petscii

`--petscii` opts the instance in to the PETSCII starter menus and theme the way
`oputil.js config new` does on Yes (#593): the PETSCII menu file is included,
`telnetConnected` branches on `TE[petscii]`, and `theme.emulations.petscii` is
set. The instance gets its own `themes/` directory (copies of the stock and
starter themes), so the checkout's `art/themes/` is not touched.
`--second-emulation=NAME` marks the second listener `emulation: NAME`.

`petscii_walk.js` is a PETSCII caller for such an instance (Node, no pyte): it
answers TTYPE with `PETSCII` and NAWS with 40x25, renders on the PETSCII screen
model from `test/term_petscii_screens.js` (which rejects bytes a Commodore
terminal must never get), walks the starter tree and prints every screen, each with a map of its
reversed cells (`#`), which is where focus shows:

    node dev_util/term_harness/petscii_walk.js --port 48901 --user tester
    node dev_util/term_harness/petscii_walk.js --port 48902 --term ''   # the listener route

It exits non-zero on any ESC byte or screen-model error.

`--walk messages` goes through the starter's message menus instead of who's
online and last callers: conference and area lists, two posts (the editor
menu opened once with F1 and once with a real ESC byte), the message list,
reading, the reader's help, and a reply with a quoted line. Run it on a fresh
instance (it expects an area holding only what it posts), then look at the
posts with `sqlite3 <instanceDir>/db/message.sqlite3`. `--walk newscan`
answers Yes to the new-message scan after login (log in as a user someone else
has posted for since), reads a new message, writes a long message and pages
and finds in it, then finds a word with two matches in the reader.

### ATASCII starter instance

    node dev_util/term_harness/make_instance.js .work/both 49301 49302 atasciiConnected --petscii --atascii --second-emulation=atascii

`--atascii` opts the instance in to the ATASCII starter the same way
(`theme.emulations.atascii`, the ATASCII menu file, a `TE[atascii]` branch).
With `--petscii` too, `telnetConnected` gets both branches, PETSCII first, as
`config new` writes them when both questions are answered Yes.

`--emulation atascii` makes `petscii_walk.js` an ATASCII caller (TTYPE
`ATASCII`, NAWS 40x24, the ATASCII screen model from
`test/term_atascii_screens.js`). ESC bytes are allowed, as ATASCII quotes
glyphs with them, but an ESC before 0x1B-0x1F (which SyncTERM draws as the
wrong characters) is counted and fails the run. Every screen is printed with a
map of its inverse cells (`#`), which is where focus shows. The walks `full`,
`messages` and `newscan` go through the ATASCII starter the way they do for
PETSCII, with Atari keys (ESC for F1, CTRL W / CTRL Z for F3 / F5, CTRL N for
CTRL G, CTRL X for CLR; the second post in `messages` is saved with CTRL S).
Two options pick how keys are sent:

* `--return syncterm` (default) sends Return as SyncTERM does, `0D 0A`;
  `--return icy` as IcyTerm does, `9B`.
* `--arrows bare` (default) sends the arrow keys as `1C`-`1F`, as SyncTERM
  does; `--arrows esc` puts ESC before them, as IcyTerm does.

For example:

    node dev_util/term_harness/petscii_walk.js --emulation atascii --walk full --port 49301 --user tester
    node dev_util/term_harness/petscii_walk.js --emulation atascii --walk messages --return icy --arrows esc --port 49301 --user tester
    node dev_util/term_harness/petscii_walk.js --emulation atascii --walk messages --term '' --port 49302 --user poster   # the listener route

`--walk native` goes through the stock matrix and login menus instead, logs
in and prints each screen; it is for checking native `.ata` art placed on
those menus by a theme of your own:

    node dev_util/term_harness/make_instance.js .work/ata 49201 49202 login --second-emulation=atascii
    node dev_util/term_harness/petscii_walk.js --emulation atascii --walk native --port 49201 --user tester

The walks log in as an existing user: create users first with `walk_nua.py`
(an ANSI caller, below), one per user name.

## Run a walk

The new-user walk creates the user; the main walk logs that user in, so run them
in this order against a fresh instance, with the same `--user`/`--password`:

    cd dev_util/term_harness
    python3 term_client.py --cols 40 --rows 25 --walk walk_nua.py  --user tester --out .work/dumps-40x25-nua
    python3 term_client.py --cols 40 --rows 25 --walk walk_main.py --user tester

Options: `--cols --rows` (default 80x25), `--term` (TTYPE, default `ansi`),
`--walk`, `--user`, `--password` (default `harnesspass1`), `--out` (default
`.work/dumps-COLSxROWS` beside the scripts), `--port`, `-v` (print each dump). A walk takes a few
minutes; it waits for the board to go quiet after every key. With no `--walk`
it just connects and dumps the first screen. Each step writes `NN-name.txt`
(numbered screen plus cursor position) to the out directory, and `raw.log` holds
the decoded byte stream. Compare two sizes with `diff -r`.

## RIPscrip callers

ENiGMA sends every ANSI caller the RIPscrip version query at connect (#989).
`term_client.py` can answer it as a RIP terminal does, with `RIPSCRIP015410`
(`--rip-version` for another):

* `--rip off` (default) does not answer: SyncTERM with RIP off, and every
  other terminal.
* `--rip prompt` answers as soon as the query arrives, as SyncTERM with RIP
  on does.
* `--rip late` leaves it to the walk, which calls `s.send_rip_reply()`.
  ENiGMA only looks for the reply for 30 seconds after sending the query,
  and takes one reply at most; a reply sent later (or a second one) is
  ordinary input and ends up in whatever field has focus, by design.
* `--rip-nul` ends the reply with a NUL, as IcyTerm does; `--term RIP` is
  IcyTerm's terminal type.

On exit the client prints `ripQueries=` (queries received) and `ripReplies=`.
`walk_rip_login.py` logs an existing user in and, under `--rip late`, sends the
reply half way through typing the user name; it exits 1 if the reply shows on
screen or the login fails. Look for `Terminal emulation layer "rip" attached`
in the instance log:

    python3 term_client.py --walk walk_rip_login.py --user tester --rip late --rip-nul
    python3 term_client.py --walk walk_rip_login.py --user tester --rip prompt --term RIP
    python3 term_client.py --walk walk_rip_login.py --user tester           # does not answer

`--raw-out FILE` (here and on `petscii_walk.js`) writes every byte received,
telnet stripped, so two builds can be compared byte for byte. `petscii_walk.js`
also prints `ripQueries=`, which must be 0 for a PETSCII or ATASCII caller.

## Reading the off-screen report

On exit the client prints, per screen label:

    OFF-SCREEN cursor moves (screen label: count, max row, max col):
      [msg-read] 4 moves, max row=24, max col=48

Each entry is a `CSI row;col H` that targeted a cell beyond the terminal size.
pyte clamps such moves, so the dumps look plausible; this report is what shows a
view being positioned past the right or bottom edge. Look at the dump with the
same label to see where the output actually went. The label is whatever the walk
last set in `s.label` (the `step()` helper sets it per step). No report means no
off-screen moves. Note that a theme or menu legitimately drawn for 80 columns will
report moves at 40, and that is the point.

## Writing a walk

A walk is a Python file defining `walk(s, args)`; `args` is the parsed command
line. See `walk_nua.py` (short) and `walk_main.py`. The session API:

    s.expect(regex, timeout=10)   # read until the rendered screen matches; TimeoutError shows the screen
    s.send('text\r', settle=0.5)  # str is encoded with the session charset; bytes pass through
    s.settle(quiet=1.0)           # read until `quiet` seconds of silence
    s.dump('name')                # write NN-name.txt, return the text
    s.text(), s.cursor()          # current screen, (row, col)
    s.label = 'name'              # tag for the off-screen report
    term_client.KEYS              # up/down/enter/esc/... escape sequences

It also works as a module: `from term_client import Session`.

## The charset seam

`Session` decodes input and encodes keystrokes only through `Session.decode()`
and `Session.encode()`, which use the Python codec named in the `CHARSETS` table
in `term_client.py` (currently `{'cp437': 'cp437'}`; chosen with `--charset`).
A PETSCII/ATASCII decoder is a codec registered with `codecs.register()` plus a
table entry and `--term` value. The off-screen detection and screen emulation
(pyte, ANSI) are separate and would need their own handling for non-ANSI
control codes.

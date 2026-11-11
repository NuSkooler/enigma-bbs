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
terminal must never get), walks the starter tree and prints every screen:

    node dev_util/term_harness/petscii_walk.js --port 48901 --user tester
    node dev_util/term_harness/petscii_walk.js --port 48902 --term ''   # the listener route

It exits non-zero on any ESC byte or screen-model error.

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

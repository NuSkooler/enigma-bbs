#!/usr/bin/env python3
"""
term_client.py - a scripted telnet caller for ENiGMA that renders what the
caller sees into a pyte screen of any size (default 80x25).

ONLY point this at a throwaway local instance. It refuses anything but
127.0.0.1/localhost unless --allow-remote is given.

Negotiates NAWS (cols x rows) and TTYPE (default 'ansi'), answers CPR
(ESC[6n) from the emulated cursor, can play a RIPscrip terminal answering
the version query (--rip; see RIP below), decodes the stream with a pluggable
charset (default CP437; see CHARSETS), and keeps a
log of every absolute cursor move (CSI row;col H/f) that lands outside the
screen, so off-screen view placement shows up even though pyte clamps it.

Use as a module:

    from term_client import Session
    s = Session('127.0.0.1', 47991, cols=40, rows=25, outdir='dumps')
    s.expect('Login')          # regex against the rendered screen text
    s.send('guest\r')
    s.settle()                 # read until 1s of quiet
    s.dump('login')            # writes dumps/NN-login.txt and returns text

or run a walk script: python3 term_client.py --port 47991 --walk walk_main.py
"""
import argparse
import codecs
import os
import re
import select
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '.work')

#  Pick up `pip install --target .work/pylib -r requirements.txt` if present.
_pylib = os.path.join(WORK, 'pylib')
if os.path.isdir(_pylib) and _pylib not in sys.path:
    sys.path.insert(0, _pylib)

try:
    import pyte
except ImportError:
    sys.exit('pyte is not installed; see README.md (pip install --target '
             'dev_util/term_harness/.work/pylib -r dev_util/term_harness/requirements.txt)')

LOOPBACK = ('127.0.0.1', 'localhost', '::1')

#  The charset seam. Session decodes received bytes and encodes sent keys with
#  the Python codec named here, so a new terminal type (PETSCII, ATASCII) is a
#  codec registered via codecs.register() plus an entry in this table (and a
#  matching --term). Nothing else assumes CP437.
CHARSETS = {'cp437': 'cp437'}
DEFAULT_CHARSET = 'cp437'

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
OPT_BINARY, OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS = 0, 1, 3, 24, 31
TTYPE_IS, TTYPE_SEND = 0, 1

CSI_GOTO = re.compile(r'\x1b\[(\d*)(?:;(\d*))?[Hf]')

#  RIP (#989). A RIPscrip terminal answers ESC [ ! and ESC [ 0 ! (whatever
#  follows) with RIPSCRIP and six digits, as if typed; IcyTerm adds a NUL.
#  --rip off      do not answer (SyncTERM with RIP off; every other terminal)
#  --rip prompt   answer as soon as the query arrives
#  --rip late     do not answer by itself; a walk calls s.send_rip_reply()
#                 when it likes (walk_rip_login.py sends it mid user name)
#  --rip-nul adds the NUL. s.rip_queries counts the queries received.
#  Under --rip prompt or late the screen is drawn as a RIP terminal's text
#  layer: a RIP command line (one that starts a line with !|) is taken off
#  the text, up to and including its line end, and kept in s.rip_lines as
#  (label, line). Graphics and buttons are not drawn.
RIP_QUERY = re.compile(rb'\x1b\[0?!')
RIP_MODES = ('off', 'prompt', 'late')
DEFAULT_RIP_VERSION = 'RIPSCRIP015410'


class _Screen(pyte.Screen):
    def __init__(self, cols, rows, reply):
        super().__init__(cols, rows)
        self._reply = reply
        #  BBS output carries parameters pyte's handlers do not take (e.g.
        #  CSI n;m D); a TypeError would kill pyte's parser generator, so
        #  retry such calls with fewer arguments instead.
        for name in set(pyte.Stream.csi.values()) | set(pyte.Stream.basic.values()):
            fn = getattr(self, name, None)
            if callable(fn):
                setattr(self, name, self._tolerant(fn))

    @staticmethod
    def _tolerant(fn):
        def call(*args, **kw):
            while True:
                try:
                    return fn(*args, **kw)
                except TypeError:
                    if kw:
                        kw = {}
                    elif args:
                        args = args[:-1]
                    else:
                        return None
        return call

    def write_process_input(self, data):  # CPR / DA replies
        self._reply(data.encode('latin-1'))


class Session:
    def __init__(self, host, port, cols=80, rows=25, term='ansi', outdir=None,
                 log=None, verbose=False, charset=DEFAULT_CHARSET,
                 allow_remote=False, rip='off', rip_nul=False,
                 rip_version=DEFAULT_RIP_VERSION):
        if host not in LOOPBACK and not allow_remote:
            raise ValueError(f'refusing to connect to {host!r}: this harness is '
                             'for throwaway local instances only '
                             '(pass --allow-remote / allow_remote=True to override)')
        self.cols, self.rows, self.term = cols, rows, term
        self.charset = CHARSETS[charset]
        self._decoder = codecs.getincrementaldecoder(self.charset)(errors='replace')
        self.sock = socket.create_connection((host, port), timeout=10)
        self.sock.setblocking(False)
        self.screen = _Screen(cols, rows, self._send_raw)
        self.stream = pyte.Stream(self.screen)
        self.outdir = outdir
        self.dump_no = 0
        self.raw = bytearray()          # everything received (telnet-stripped)
        self.label = 'connect'
        self.offscreen = []             # (label, row, col)
        self.verbose = verbose
        self._iac = bytearray()
        if rip not in RIP_MODES:
            raise ValueError(f'rip must be one of {RIP_MODES}, not {rip!r}')
        self.rip = rip
        self.rip_nul = rip_nul
        self.rip_version = rip_version
        self.rip_queries = 0
        self.rip_replies = 0
        self._rip_scanned = 0           # how far into self.raw queries were counted
        self.rip_lines = []             # (label, RIP command line) under --rip on
        self._rip_state = 'bol'         # bol, bang, cmd or mid (see _rip_text)
        self._rip_cmd = []
        if outdir:
            os.makedirs(outdir, exist_ok=True)
        self.log = open(log, 'w') if log else None

    # ---- telnet --------------------------------------------------------
    def _send_raw(self, data):
        self.sock.sendall(data)

    def _naws(self):
        b = bytes([IAC, SB, OPT_NAWS, self.cols >> 8, self.cols & 0xff,
                   self.rows >> 8, self.rows & 0xff, IAC, SE])
        self._send_raw(b)

    def _handle_cmd(self, cmd, opt):
        if cmd == DO:
            if opt in (OPT_NAWS, OPT_TTYPE, OPT_BINARY, OPT_SGA):
                self._send_raw(bytes([IAC, WILL, opt]))
                if opt == OPT_NAWS:
                    self._naws()
            else:
                self._send_raw(bytes([IAC, WONT, opt]))
        elif cmd == WILL:
            if opt in (OPT_ECHO, OPT_SGA, OPT_BINARY):
                self._send_raw(bytes([IAC, DO, opt]))
            else:
                self._send_raw(bytes([IAC, DONT, opt]))

    def _handle_sb(self, payload):
        if payload[:2] == bytes([OPT_TTYPE, TTYPE_SEND]):
            self._send_raw(bytes([IAC, SB, OPT_TTYPE, TTYPE_IS]) +
                           self.term.encode() + bytes([IAC, SE]))

    def _strip_telnet(self, data):
        out = bytearray()
        buf = self._iac + data
        self._iac = bytearray()
        i = 0
        while i < len(buf):
            b = buf[i]
            if b != IAC:
                out.append(b)
                i += 1
                continue
            if i + 1 >= len(buf):
                self._iac = buf[i:]
                break
            c = buf[i + 1]
            if c == IAC:
                out.append(IAC)
                i += 2
            elif c in (DO, DONT, WILL, WONT):
                if i + 2 >= len(buf):
                    self._iac = buf[i:]
                    break
                self._handle_cmd(c, buf[i + 2])
                i += 3
            elif c == SB:
                end = buf.find(bytes([IAC, SE]), i + 2)
                if end < 0:
                    self._iac = buf[i:]
                    break
                self._handle_sb(bytes(buf[i + 2:end]))
                i = end + 2
            else:
                i += 2
        return bytes(out)

    # ---- RIP ------------------------------------------------------------
    def send_rip_reply(self):
        """Answer as a RIPscrip terminal would (with the NUL under --rip-nul)."""
        reply = self.rip_version.encode('latin-1')
        if self.rip_nul:
            reply += b'\x00'
        self._send_raw(reply)
        self.rip_replies += 1

    def _rip_scan(self):
        #  look for queries in what arrived since last time; keep the last two
        #  bytes in view so a query split across reads is still seen
        start = max(0, self._rip_scanned - 3)
        found = 0
        for m in RIP_QUERY.finditer(self.raw, start):
            if m.end() > self._rip_scanned:
                found += 1
        self._rip_scanned = len(self.raw)
        self.rip_queries += found
        if found and self.rip == 'prompt':
            for _ in range(found):
                self.send_rip_reply()

    def _rip_text(self, text):
        #  what a RIP terminal's text layer gets: command lines taken out
        if self.rip == 'off':
            return text
        out = []
        for ch in text:
            if self._rip_state == 'cmd':
                if ch == '\n':
                    self.rip_lines.append((self.label, ''.join(self._rip_cmd)))
                    self._rip_cmd = []
                    self._rip_state = 'bol'
                elif ch != '\r':
                    self._rip_cmd.append(ch)
                continue
            if self._rip_state == 'bang':
                if ch == '|':
                    self._rip_state = 'cmd'
                    self._rip_cmd = ['!', '|']
                    continue
                out.append('!')
                self._rip_state = 'mid'
            if self._rip_state == 'bol' and ch == '!':
                self._rip_state = 'bang'
                continue
            out.append(ch)
            self._rip_state = 'bol' if ch in '\r\n' else 'mid'
        return ''.join(out)

    # ---- charset (the seam) ---------------------------------------------
    def decode(self, data):
        return self._decoder.decode(data)

    def encode(self, text):
        return text.encode(self.charset, errors='replace')

    # ---- I/O -----------------------------------------------------------
    def _pump(self, timeout):
        r, _, _ = select.select([self.sock], [], [], timeout)
        if not r:
            return False
        try:
            data = self.sock.recv(65536)
        except BlockingIOError:
            return False
        if not data:
            raise EOFError('connection closed')
        data = self._strip_telnet(data)
        if data:
            self.raw += data
            self._rip_scan()
            text = self.decode(data)
            if self.log:
                self.log.write(text)
            for m in CSI_GOTO.finditer(text):
                row = int(m.group(1) or 1)
                col = int(m.group(2) or 1)
                if row > self.rows or col > self.cols:
                    self.offscreen.append((self.label, row, col))
            self.stream.feed(self._rip_text(text))
        return True

    def settle(self, quiet=1.0, maximum=15.0):
        """Read until |quiet| seconds pass with no data (or |maximum|)."""
        end = time.time() + maximum
        while time.time() < end:
            if not self._pump(quiet):
                return
        if self.verbose:
            print('settle: hit maximum', file=sys.stderr)

    def expect(self, pattern, timeout=10.0, flags=re.I):
        """Read until the rendered screen matches regex |pattern|."""
        rx = re.compile(pattern, flags)
        end = time.time() + timeout
        while True:
            if rx.search(self.text()):
                return True
            left = end - time.time()
            if left <= 0:
                raise TimeoutError(f'expect {pattern!r} timed out; screen:\n' +
                                   self.text(numbered=True))
            self._pump(min(left, 0.25))

    def send(self, keys, settle=None):
        if isinstance(keys, str):
            keys = self.encode(keys)
        self._send_raw(keys)
        if settle:
            self.settle(settle)

    # ---- inspection ----------------------------------------------------
    def text(self, numbered=False):
        lines = self.screen.display
        if numbered:
            return '\n'.join(f'{i + 1:2}|{l}|' for i, l in enumerate(lines))
        return '\n'.join(lines)

    def cursor(self):
        return (self.screen.cursor.y + 1, self.screen.cursor.x + 1)

    def dump(self, name):
        self.dump_no += 1
        r, c = self.cursor()
        body = (f'== {name}  ({self.cols}x{self.rows})  cursor row={r} col={c}\n'
                + self.text(numbered=True) + '\n')
        if self.outdir:
            fn = os.path.join(self.outdir, f'{self.dump_no:02}-{name}.txt')
            with open(fn, 'w') as f:
                f.write(body)
        if self.verbose:
            print(body)
        return body

    def close(self):
        try:
            self.sock.close()
        finally:
            if self.log:
                self.log.close()


KEYS = {
    'up': '\x1b[A', 'down': '\x1b[B', 'right': '\x1b[C', 'left': '\x1b[D',
    'enter': '\r', 'esc': '\x1b', 'tab': '\t', 'bs': '\x08',
    'home': '\x1b[H', 'end': '\x1b[K', 'pgup': '\x1b[V', 'pgdn': '\x1b[U',
}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=47991)
    ap.add_argument('--cols', type=int, default=80)
    ap.add_argument('--rows', type=int, default=25)
    ap.add_argument('--term', default='ansi')
    ap.add_argument('--charset', default=DEFAULT_CHARSET, choices=sorted(CHARSETS))
    ap.add_argument('--allow-remote', action='store_true',
                    help='permit a non-loopback --host (dangerous; see README)')
    ap.add_argument('--out', help='dump directory (default .work/dumps-COLSxROWS)')
    ap.add_argument('--walk', help='python file defining walk(session, args); a '
                    'bare name is also looked up beside this script')
    ap.add_argument('--rip', default='off', choices=RIP_MODES,
                    help='answer the RIPscrip version query: off (do not), '
                    'prompt (at once), late (when the walk says)')
    ap.add_argument('--rip-nul', action='store_true',
                    help='end the RIP reply with a NUL, as IcyTerm does')
    ap.add_argument('--rip-version', default=DEFAULT_RIP_VERSION)
    ap.add_argument('--raw-out', help='write every byte received (telnet '
                    'stripped) to this file, to compare two builds')
    ap.add_argument('--user', default='harness')
    ap.add_argument('--password', default='harnesspass1')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()

    if not args.out:
        args.out = os.path.join(WORK, f'dumps-{args.cols}x{args.rows}')
    walk_path = args.walk
    if walk_path and not os.path.exists(walk_path):
        walk_path = os.path.join(HERE, walk_path)
    try:
        s = Session(args.host, args.port, args.cols, args.rows, args.term,
                    outdir=args.out, log=os.path.join(args.out, 'raw.log'),
                    verbose=args.verbose, charset=args.charset,
                    allow_remote=args.allow_remote, rip=args.rip,
                    rip_nul=args.rip_nul, rip_version=args.rip_version)
    except ValueError as e:
        sys.exit(str(e))
    try:
        if args.walk:
            ns = {}
            with open(walk_path) as f:
                exec(compile(f.read(), walk_path, 'exec'), ns)
            ns['walk'](s, args)
        else:
            s.settle(2.0)
            s.dump('connect')
    finally:
        if s.offscreen:
            print('OFF-SCREEN cursor moves (screen label: count, max row, max col):')
            summary = {}
            for lab, r, c in s.offscreen:
                n, mr, mc = summary.get(lab, (0, 0, 0))
                summary[lab] = (n + 1, max(mr, r), max(mc, c))
            for lab, (n, mr, mc) in summary.items():
                print(f'  [{lab}] {n} moves, max row={mr}, max col={mc}')
        print(f'bytes={len(s.raw)} ripQueries={s.rip_queries} '
              f'ripReplies={s.rip_replies}')
        if args.raw_out:
            with open(args.raw_out, 'wb') as f:
                f.write(bytes(s.raw))
        s.close()


if __name__ == '__main__':
    main()

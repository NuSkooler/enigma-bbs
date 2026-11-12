'use strict';

//
//  A scripted PETSCII telnet caller for the PETSCII starter menus (#593).
//
//  Answers DO TTYPE with "PETSCII" and NAWS with 40x25, strips telnet
//  commands, and renders everything else on the PETSCII screen model from
//  test/term_petscii_screens.js, which throws on any byte a Commodore
//  terminal must never be sent (those are counted as errors). Walks the
//  starter tree and prints each screen as text.
//
//  Only for a throwaway local instance (see README.md): it logs in.
//
//      node petscii_walk.js --port 48901 [--user tester] [--password harnesspass1]
//                           [--term PETSCII] [--walk full|connect|messages|newscan]
//
//  --walk connect stops after the first menu (to check a route in); --term ''
//  sends no terminal type (a dedicated PETSCII listener does not need one).
//
//  --walk messages logs in and goes through the message menus instead of
//  who's online and last callers: conference and area lists, a post saved
//  through the editor menu opened with F1, a second one opened with a real
//  ESC byte, the message list, reading, the reader's help, a reply with a
//  quoted line, and back out to log off. Run it once per fresh instance:
//  it expects an area holding only what it posts. The other walks answer No
//  to the new-message scan after login.
//
//  --emulation atascii is an ATASCII caller instead: TTYPE "ATASCII", NAWS
//  40x24, rendered on the ATASCII screen model from
//  test/term_atascii_screens.js (same rule: a byte an Atari terminal must
//  never get from ENiGMA's translator is an error; ESC is allowed, ATASCII
//  quotes glyphs with it). Only --walk connect and --walk native exist for
//  it so far; --walk native goes through the stock matrix and login menus
//  (for checking native .ata art on them) and logs in.
//
//  --walk newscan answers Yes to the scan (run it as a user someone else has
//  posted for since), reads a new message, then writes a long message,
//  paging it with F3 / F5 and finding a word with CTRL F, saves it with F1,
//  and in the reader finds a word that is in it twice, steps to the second
//  match with CTRL G and leaves find.
//
const net = require('net');
const paths = require('path');

const root = paths.resolve(__dirname, '../..');
const { PetsciiScreen } = require(paths.join(root, 'test/term_petscii_screens.js'));
const { AtasciiScreen } = require(paths.join(root, 'test/term_atascii_screens.js'));
const { encode, Controls } = require(paths.join(root, 'core/term/petscii/charset.js'));
const atascii = require(paths.join(root, 'core/term/atascii/charset.js'));

const EMULATIONS = {
    petscii: {
        term: 'PETSCII',
        cols: 40,
        rows: 25,
        screen: () => new PetsciiScreen(40, 25, { row: 0, col: 0 }),
        encode: text => encode(text, 'lower'),
        escIsError: true,
    },
    atascii: {
        term: 'ATASCII',
        cols: 40,
        rows: 24,
        screen: () => new AtasciiScreen(40, 24, { row: 0, col: 0 }),
        encode: text => atascii.encode(text),
        escIsError: false,
    },
};

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const TTYPE = 24;
const NAWS = 31;
const ECHO = 1;
const SGA = 3;

function parseArgs() {
    const out = {
        port: 48901,
        user: 'tester',
        password: 'harnesspass1',
        emulation: 'petscii',
        walk: 'full',
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        out[argv[i].replace(/^--/, '')] = argv[i + 1];
    }
    out.port = parseInt(out.port, 10);
    if (!EMULATIONS[out.emulation]) {
        throw new Error(`--emulation: petscii or atascii, not ${out.emulation}`);
    }
    if (undefined === out.term) {
        out.term = EMULATIONS[out.emulation].term;
    }
    return out;
}

class Caller {
    constructor({ port, term, emulation = 'petscii' }) {
        this.term = term;
        this.emu = EMULATIONS[emulation];
        this.cols = this.emu.cols;
        this.rows = this.emu.rows;
        this.screen = this.emu.screen();
        this.errors = [];
        this.escBytes = 0;
        this.dataBytes = 0;
        this.lastData = Date.now();
        this.closed = false;
        this.pending = Buffer.alloc(0);
        this.sock = net.connect(port, '127.0.0.1');
        this.sock.on('data', d => this._onData(d));
        this.sock.on('close', () => (this.closed = true));
        this.sock.on('error', e => this.errors.push(`socket: ${e.message}`));
    }

    _send(bytes) {
        if (!this.closed) {
            this.sock.write(Buffer.from(bytes));
        }
    }

    _onData(d) {
        this.lastData = Date.now();
        let buf = Buffer.concat([this.pending, d]);
        this.pending = Buffer.alloc(0);
        let i = 0;
        while (i < buf.length) {
            const b = buf[i];
            if (b !== IAC) {
                this._render(b);
                ++i;
                continue;
            }
            if (i + 1 >= buf.length) {
                this.pending = buf.slice(i);
                return;
            }
            const cmd = buf[i + 1];
            if (cmd === IAC) {
                this._render(IAC);
                i += 2;
            } else if (cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) {
                if (i + 2 >= buf.length) {
                    this.pending = buf.slice(i);
                    return;
                }
                this._negotiate(cmd, buf[i + 2]);
                i += 3;
            } else if (cmd === SB) {
                const end = buf.indexOf(Buffer.from([IAC, SE]), i);
                if (end < 0) {
                    this.pending = buf.slice(i);
                    return;
                }
                const sub = buf.slice(i + 2, end);
                if (sub[0] === TTYPE && sub[1] === 1 && this.term) {
                    this._send([IAC, SB, TTYPE, 0, ...Buffer.from(this.term), IAC, SE]);
                }
                i = end + 2;
            } else {
                i += 2;
            }
        }
    }

    _negotiate(cmd, opt) {
        if (cmd === DO) {
            if (opt === TTYPE && this.term) {
                this._send([IAC, WILL, TTYPE]);
            } else if (opt === NAWS) {
                this._send([
                    ...[IAC, WILL, NAWS, IAC, SB, NAWS],
                    ...[0, this.cols, 0, this.rows, IAC, SE],
                ]);
            } else {
                this._send([IAC, WONT, opt]);
            }
        } else if (cmd === WILL) {
            this._send([IAC, opt === ECHO || opt === SGA ? DO : DONT, opt]);
        }
    }

    _render(b) {
        ++this.dataBytes;
        if (0x1b === b) {
            ++this.escBytes;
        }
        try {
            this.screen.apply(b);
        } catch (e) {
            this.errors.push(e.message);
        }
    }

    text() {
        const lines = [];
        for (let r = 0; r < this.rows; ++r) {
            let line = '';
            for (let c = 0; c < this.cols; ++c) {
                line += this.screen.actual(r, c).ch;
            }
            lines.push(line.replace(/\s+$/, ''));
        }
        return lines.join('\n');
    }

    async expect(re, timeout = 15000) {
        const start = Date.now();
        while (!re.test(this.text())) {
            if (Date.now() - start > timeout) {
                throw new Error(`timed out waiting for ${re}; screen:\n${this.text()}`);
            }
            await sleep(100);
        }
        return this.settle();
    }

    async settle(quiet = 800) {
        while (Date.now() - this.lastData < quiet) {
            await sleep(100);
        }
    }

    async type(text) {
        this._send(this.emu.encode(text));
        await sleep(150);
    }

    async key(byte) {
        this._send([byte]);
        await sleep(150);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dump(caller, label) {
    const bar = '+' + '-'.repeat(caller.cols) + '+';
    console.log(
        `\n[${label}]  (cursor ${caller.screen.row + 1},${caller.screen.col + 1})`
    );
    console.log(bar);
    caller
        .text()
        .split('\n')
        .forEach(l => console.log('|' + l.padEnd(caller.cols) + '|'));
    console.log(bar);
}

//  inverse cells as a second picture: '#' inverse, '.' normal (ATASCII)
function dumpInverse(caller, label) {
    console.log(`[${label}: inverse cells]`);
    for (let r = 0; r < caller.rows; ++r) {
        let line = '';
        for (let c = 0; c < caller.cols; ++c) {
            line += caller.screen.actual(r, c).inverse ? '#' : '.';
        }
        if (line.includes('#')) {
            console.log(`${String(r + 1).padStart(2)} ${line}`);
        }
    }
}

//  --emulation atascii --walk native: stock matrix and login menus
async function atasciiNativeWalk(c, args) {
    const EOL = atascii.Controls.eol;
    await c.expect(/Pick one|MATRIX|login/);
    dump(c, 'matrix');
    dumpInverse(c, 'matrix');
    await c.key(EOL); //  the first item: login
    await c.expect(/User:|LOGIN|ogin/);
    dump(c, 'login');
    dumpInverse(c, 'login');
    await c.type(args.user);
    await c.key(EOL);
    await c.type(args.password);
    await c.settle();
    dump(c, 'login, typed');
    dumpInverse(c, 'login, typed');
    await c.key(EOL);
    for (let i = 0; i < 3; ++i) {
        await sleep(2500);
        await c.settle();
        dump(c, `after login ${i + 1}`);
        await c.key(EOL);
    }
}

async function main() {
    const args = parseArgs();
    const c = new Caller(args);

    if ('atascii' === args.emulation) {
        if ('native' === args.walk) {
            await atasciiNativeWalk(c, args);
        } else {
            await c.expect(/\S/);
            await c.settle(1500);
            dump(c, 'connect');
        }
        return finish(c);
    }

    await c.expect(/Commodore caller/);
    dump(c, 'connect');
    await c.expect(/Pick one/);
    dump(c, 'matrix');
    if ('connect' === args.walk) {
        return finish(c);
    }

    await c.type('a');
    await c.expect(/New users/);
    await c.expect(/press a key/);
    dump(c, 'apply notice');
    await c.key(Controls.return);
    await c.expect(/Pick one/);
    dump(c, 'matrix again');

    await c.type('l');
    await c.expect(/User name/);
    dump(c, 'login');
    await c.type(args.user);
    await c.key(Controls.return);
    await c.type(args.password);
    await c.key(Controls.return);
    await c.expect(/last callers/);
    await c.expect(/press a key/);
    dump(c, 'last callers (login)');
    await c.key(Controls.return);
    //  the new-message scan question; anything the system shows on its own
    //  in between (an achievement popup on a return call, say) waits for a key
    for (let i = 0; i < 8 && !/main menu/.test(c.text()); ++i) {
        await c.expect(/main menu|press a key|Look for new messages/);
        if (/Look for new messages/.test(c.text())) {
            dump(c, 'new scan question');
            if ('newscan' === args.walk) {
                await newScanAtLogin(c);
            } else {
                await c.type('n');
            }
            await c.settle();
        } else if (!/main menu/.test(c.text())) {
            dump(c, 'interstitial');
            await c.key(Controls.return);
            await c.settle();
        }
    }
    await c.expect(/main menu/);
    dump(c, 'main menu');

    if ('messages' === args.walk) {
        await messagesWalk(c);
    } else if ('newscan' === args.walk) {
        await findAndPageWalk(c);
    } else {
        await whosOnlineAndLastCallers(c);
    }

    await c.type('g');
    await c.expect(/Thanks for calling/);
    dump(c, 'log off');
    const start = Date.now();
    while (!c.closed && Date.now() - start < 10000) {
        await sleep(100);
    }
    dump(c, 'after hang up');
    return finish(c);
}

async function whosOnlineAndLastCallers(c) {
    await c.type('w');
    await c.expect(/who's online/);
    await c.expect(/press a key/);
    dump(c, "who's online");
    await c.key(Controls.return);
    await c.expect(/main menu/);

    await c.type('l');
    await c.expect(/last callers/);
    await c.expect(/press a key/);
    dump(c, 'last callers (main menu)');
    await c.key(Controls.return);
    await c.expect(/main menu/);
    dump(c, 'main menu again');
}

//  waits for |re|; anything the system shows on its own in between (an
//  achievement after a post, say) waits for a key, which it gets
async function expectThrough(c, re) {
    for (let i = 0; i < 5; ++i) {
        await c.expect(new RegExp(`${re.source}|press a key`));
        if (re.test(c.text())) {
            return;
        }
        dump(c, 'interstitial');
        await c.key(Controls.return);
        await c.settle();
    }
    await c.expect(re);
}

const F1 = 0x85;
const F3 = 0x86; //  page up for a PETSCII caller
const F5 = 0x87; //  page down
const ESC = 0x1b;
const CTRL_F = 0x06; //  find
const CTRL_G = 0x07; //  next match (in the reader)

//  --walk newscan: yes to the scan, read the first new message, back out
async function newScanAtLogin(c) {
    await c.type('y');
    await c.expect(/new messages/);
    await c.expect(/RETURN read/);
    dump(c, 'new scan: new messages');
    await c.key(Controls.return);
    await c.expect(/read a message/);
    dump(c, 'new scan: reading');
    await c.type('q');
    await c.expect(/RETURN read/);
    await c.type('q'); //  on to the next area
    await expectThrough(c, /Done\./);
    dump(c, 'new scan: done');
    await c.key(Controls.return);
}

//  --walk newscan, after login: page and find in the editor on a long
//  message, save it with F1, then find with two matches in the reader
async function findAndPageWalk(c) {
    await c.type('m');
    await c.expect(/list messages/);
    dump(c, 'message menu');
    await c.type('p');
    await c.expect(/write a message/);
    await c.key(Controls.return);
    await c.type('Fruit, a long list');
    await c.key(Controls.return);
    for (let i = 1; i <= 24; ++i) {
        const fruit = 3 === i || 21 === i ? 'apple' : 'pear';
        await c.type(`Row ${i}: a ${fruit} a day.`);
        if (i < 24) {
            await c.key(Controls.return);
        }
    }
    await c.settle();
    dump(c, 'editor: 24 rows typed');
    await c.key(F3);
    await c.settle();
    dump(c, 'editor: F3 (page up)');
    await c.key(F3);
    await c.settle();
    dump(c, 'editor: F3 again');
    await c.key(F5);
    await c.settle();
    dump(c, 'editor: F5 (page down)');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    dump(c, 'editor: CTRL F');
    await c.type('apple');
    await c.key(Controls.return);
    await c.expect(/F1: save/);
    dump(c, 'editor: found');
    await c.key(F1);
    await c.expect(/save/);
    await c.type('s');
    await expectThrough(c, /list messages/);

    await c.type('l');
    await expectThrough(c, /RETURN read/);
    await c.key(0x93); //  CLR, i.e. End: the last message
    await c.key(Controls.return);
    await c.expect(/Row 1: a pear/);
    dump(c, 'reader: the long message');
    await c.key(F5);
    await c.settle();
    dump(c, 'reader: F5 (page down)');
    await c.key(F3);
    await c.settle();
    dump(c, 'reader: F3 (page up)');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    await c.type('apple');
    await c.key(Controls.return);
    await c.expect(/prev {2}next/);
    dump(c, 'reader: found, first of two');
    await c.key(CTRL_G);
    await c.settle();
    dump(c, 'reader: CTRL G, second match');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    await c.key(F1);
    await c.expect(/prev {2}next/);
    dump(c, 'reader: find left (CTRL F, F1)');
    await c.type('q');
    await c.expect(/RETURN read/);
    await c.type('q');
    await c.expect(/list messages/);
    await c.type('q');
    await c.expect(/main menu/);
}

//  writes a new message from the message menu; |menuKey| opens the editor menu
async function postMessage(c, subject, lines, menuKey, label) {
    await c.type('p');
    await c.expect(/write a message/);
    dump(c, `${label}: editor`);
    await c.key(Controls.return); //  To: keep "All"
    await c.type(subject);
    await c.key(Controls.return);
    for (let i = 0; i < lines.length; ++i) {
        await c.type(lines[i]);
        if (i < lines.length - 1) {
            await c.key(Controls.return);
        }
    }
    await c.settle();
    dump(c, `${label}: written`);
    await c.key(menuKey);
    await c.expect(/save/);
    dump(c, `${label}: editor menu`);
}

async function messagesWalk(c) {
    await c.type('m');
    await c.expect(/list messages/);
    dump(c, 'message menu');

    await c.type('j');
    await c.expect(/Join a conference/);
    dump(c, 'conference list');
    await c.key(Controls.return);
    await c.expect(/list messages/);

    await c.type('a');
    await c.expect(/Pick a message area/);
    dump(c, 'area list');
    await c.key(Controls.return);
    await c.expect(/list messages/);
    dump(c, 'message menu, area picked');

    //  saved through the editor menu opened with F1, saving with S
    await postMessage(
        c,
        'Hello from a C64',
        ['First line from a Commodore.', 'Second line, typed at 40 columns, wraps here.'],
        F1,
        'post (F1)'
    );
    await c.type('s');
    await expectThrough(c, /list messages/);
    dump(c, 'message menu after post (F1)');

    //  the same with a real ESC byte, saving with RETURN (save is first)
    await postMessage(
        c,
        'Second post via ESC',
        ['Escape works too.', 'Bye.'],
        ESC,
        'post (ESC)'
    );
    await c.key(Controls.return);
    await expectThrough(c, /list messages/);
    dump(c, 'message menu after post (ESC)');

    await c.type('l');
    await expectThrough(c, /Hello from a C64/);
    dump(c, 'message list');

    await c.key(Controls.return);
    await c.expect(/read a message/);
    await c.expect(/wraps here/);
    dump(c, 'read message 1');

    await c.type('n');
    await c.expect(/Escape works too/);
    dump(c, 'read message 2 (N)');

    await c.type('p');
    await c.expect(/First line from/);
    dump(c, 'read message 1 again (P)');

    await c.type('?');
    await c.expect(/reader keys/);
    dump(c, 'reader help');
    await c.key(Controls.return);
    await c.expect(/read a message/);

    //  reply, quoting a line
    await c.type('r');
    await c.expect(/write a message/);
    await c.expect(/RE: Hello/);
    dump(c, 'reply: editor');
    await c.key(Controls.return); //  To: the author
    await c.key(Controls.return); //  Subject: RE: ...
    await c.settle();
    await c.key(F1);
    await c.expect(/quote/);
    dump(c, 'reply: editor menu');
    await c.type('q');
    await c.expect(/Quote: RETURN/);
    dump(c, 'reply: quote builder');
    await c.key(Controls.return); //  the first line
    await c.settle();
    dump(c, 'reply: quote builder, a line picked');
    await c.key(F1);
    await c.settle();
    await c.type('A reply from the C64.');
    await c.settle();
    dump(c, 'reply: written');
    await c.key(F1);
    await c.expect(/save/);
    await c.type('s');
    await expectThrough(c, /read a message/);
    dump(c, 'reader after reply');

    await c.type('q');
    await c.expect(/RE: Hello/);
    dump(c, 'message list after reply');
    await c.type('q');
    await c.expect(/list messages/);
    await c.type('q');
    await c.expect(/main menu/);
    dump(c, 'main menu after messages');
}

function finish(c) {
    console.log(
        `\nbytes=${c.dataBytes} esc=${c.escBytes} modelErrors=${c.errors.length} closedByServer=${c.closed}`
    );
    c.errors.slice(0, 10).forEach(e => console.log(`  ${e}`));
    c.sock.destroy();
    process.exitCode = c.errors.length || (c.emu.escIsError && c.escBytes) ? 1 : 0;
}

module.exports = { Caller, dump };

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(2);
    });
}

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
//  quotes glyphs with it, but an ESC before 0x1B-0x1F, which SyncTERM
//  misdraws, is counted and fails the run). Every screen is printed with a
//  map of its inverse cells. The walks full, messages and newscan go
//  through the ATASCII starter the same way as for PETSCII, with Atari keys:
//  ESC for F1, CTRL W / CTRL Z for F3 / F5, CTRL N for CTRL G, CTRL X for
//  CLR, and in the messages walk CTRL S (quick save) for the second post.
//  --return syncterm sends Return as SyncTERM does (0D 0A, the default),
//  --return icy as IcyTerm does (9B); --arrows bare sends arrows as bytes
//  1C-1F (SyncTERM, the default), --arrows esc with an ESC before them
//  (IcyTerm). --walk native goes through the stock matrix and login menus
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
const { encode } = require(paths.join(root, 'core/term/petscii/charset.js'));
const atascii = require(paths.join(root, 'core/term/atascii/charset.js'));

//  arrows: [up, down, left, right]
const PETSCII_KEYS = {
    ret: [0x0d],
    menu: [0x85], //  F1
    pageUp: [0x86], //  F3
    pageDown: [0x87], //  F5
    findNext: [0x07], //  CTRL G
    end: [0x93], //  CLR
    quickSave: null,
    arrows: [[0x91], [0x11], [0x9d], [0x1d]],
    welcome: /Commodore caller/,
    machine: 'a C64',
    editorFooter: /F1: save/,
    menuKey: 'F1',
};

function atasciiKeys(ret, arrows) {
    const esc = 'esc' === arrows ? [0x1b] : [];
    return {
        ret: 'icy' === ret ? [0x9b] : [0x0d, 0x0a],
        menu: [0x1b],
        pageUp: [0x17], //  CTRL W
        pageDown: [0x1a], //  CTRL Z
        findNext: [0x0e], //  CTRL N
        end: [0x18], //  CTRL X
        quickSave: [0x13], //  CTRL S
        arrows: [0x1c, 0x1d, 0x1e, 0x1f].map(b => [...esc, b]),
        welcome: /Atari caller/,
        machine: 'an Atari',
        editorFooter: /ESC: save/,
        menuKey: 'ESC',
    };
}

const EMULATIONS = {
    petscii: {
        term: 'PETSCII',
        cols: 40,
        rows: 25,
        screen: () => new PetsciiScreen(40, 25, { row: 0, col: 0 }),
        encode: text => encode(text, 'lower'),
        escIsError: true,
        keys: () => PETSCII_KEYS,
    },
    atascii: {
        term: 'ATASCII',
        cols: 40,
        rows: 24,
        screen: () => new AtasciiScreen(40, 24, { row: 0, col: 0 }),
        encode: text => atascii.encode(text),
        escIsError: false,
        keys: args => atasciiKeys(args.return, args.arrows),
        showInverse: true,
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
        return: 'syncterm',
        arrows: 'bare',
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
    constructor(args) {
        const { port, term, emulation = 'petscii' } = args;
        this.term = term;
        this.emu = EMULATIONS[emulation];
        this.k = this.emu.keys(args);
        this.badEsc = 0; //  ESC before 0x1B-0x1F (ATASCII; SyncTERM misdraws it)
        this.afterEsc = false;
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
        if (this.afterEsc && b >= 0x1b && b <= 0x1f) {
            ++this.badEsc;
        }
        this.afterEsc = 0x1b === b && !this.afterEsc;
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

    //  a key that is one or more bytes (this.k)
    async keys(bytes) {
        this._send(bytes);
        await sleep(150);
    }

    async ret() {
        return this.keys(this.k.ret);
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
    if (caller.emu.showInverse) {
        dumpInverse(caller, label);
    }
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
    await c.key(EOL); //  the first item: login
    await c.expect(/User:|LOGIN|ogin/);
    dump(c, 'login');
    await c.type(args.user);
    await c.key(EOL);
    await c.type(args.password);
    await c.settle();
    dump(c, 'login, typed');
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

    if ('atascii' === args.emulation && 'native' === args.walk) {
        await atasciiNativeWalk(c, args);
        return finish(c);
    }
    if ('atascii' === args.emulation && '' === args.term && 'connect' === args.walk) {
        await c.expect(/\S/);
        await c.settle(1500);
        dump(c, 'connect');
        return finish(c);
    }

    await c.expect(c.k.welcome);
    dump(c, 'connect');
    await c.expect(/Pick one/);
    dump(c, 'matrix');
    if ('connect' === args.walk) {
        return finish(c);
    }
    if (c.emu.showInverse) {
        //  focus moves with the arrow keys and shows as inverse video
        await c.keys(c.k.arrows[1]);
        await c.settle();
        dump(c, 'matrix, arrow down');
        await c.keys(c.k.arrows[0]);
        await c.settle();
        dump(c, 'matrix, arrow up');
    }

    await c.type('a');
    await c.expect(/New users/);
    await c.expect(/press a key/);
    dump(c, 'apply notice');
    await c.ret();
    await c.expect(/Pick one/);
    dump(c, 'matrix again');

    await c.type('l');
    await c.expect(/User name/);
    dump(c, 'login');
    await c.type(args.user);
    await c.ret();
    await c.type(args.password);
    await c.ret();
    await c.expect(/last callers/);
    await c.expect(/press a key/);
    dump(c, 'last callers (login)');
    await c.ret();
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
            await c.ret();
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
    await c.ret();
    await c.expect(/main menu/);

    await c.type('l');
    await c.expect(/last callers/);
    await c.expect(/press a key/);
    dump(c, 'last callers (main menu)');
    await c.ret();
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
        await c.ret();
        await c.settle();
    }
    await c.expect(re);
}

const ESC = 0x1b;
const CTRL_F = 0x06; //  find (both emulations)

//  --walk newscan: yes to the scan, read the first new message, back out
async function newScanAtLogin(c) {
    await c.type('y');
    await c.expect(/new messages/);
    await c.expect(/RETURN read/);
    dump(c, 'new scan: new messages');
    await c.ret();
    await c.expect(/read a message/);
    dump(c, 'new scan: reading');
    await c.type('q');
    await c.expect(/RETURN read/);
    await c.type('q'); //  on to the next area
    await expectThrough(c, /Done\./);
    dump(c, 'new scan: done');
    await c.ret();
}

//  --walk newscan, after login: page and find in the editor on a long
//  message, save it with F1, then find with two matches in the reader
async function findAndPageWalk(c) {
    await c.type('m');
    await c.expect(/list messages/);
    dump(c, 'message menu');
    await c.type('p');
    await c.expect(/write a message/);
    await c.ret();
    await c.type('Fruit, a long list');
    await c.ret();
    for (let i = 1; i <= 24; ++i) {
        const fruit = 3 === i || 21 === i ? 'apple' : 'pear';
        await c.type(`Row ${i}: a ${fruit} a day.`);
        if (i < 24) {
            await c.ret();
        }
    }
    await c.settle();
    dump(c, 'editor: 24 rows typed');
    await c.keys(c.k.pageUp);
    await c.settle();
    dump(c, 'editor: page up');
    await c.keys(c.k.pageUp);
    await c.settle();
    dump(c, 'editor: page up again');
    await c.keys(c.k.pageDown);
    await c.settle();
    dump(c, 'editor: page down');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    dump(c, 'editor: CTRL F');
    await c.type('apple');
    await c.ret();
    await c.expect(c.k.editorFooter);
    dump(c, 'editor: found');
    await c.keys(c.k.menu);
    await c.expect(/save/);
    await c.type('s');
    await expectThrough(c, /list messages/);

    await c.type('l');
    await expectThrough(c, /RETURN read/);
    await c.keys(c.k.end); //  End: the last message
    await c.ret();
    await c.expect(/Row 1: a pear/);
    dump(c, 'reader: the long message');
    await c.keys(c.k.pageDown);
    await c.settle();
    dump(c, 'reader: page down');
    await c.keys(c.k.pageUp);
    await c.settle();
    dump(c, 'reader: page up');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    await c.type('apple');
    await c.ret();
    await c.expect(/prev {2}next/);
    dump(c, 'reader: found, first of two');
    await c.keys(c.k.findNext);
    await c.settle();
    dump(c, 'reader: find next, second match');
    await c.key(CTRL_F);
    await c.expect(/RETURN finds/);
    await c.keys(c.k.menu);
    await c.expect(/prev {2}next/);
    dump(c, 'reader: find left (CTRL F, then the menu key)');
    await c.type('q');
    await c.expect(/RETURN read/);
    await c.type('q');
    await c.expect(/list messages/);
    await c.type('q');
    await c.expect(/main menu/);
}

//  writes a new message from the message menu; |menuKey| (bytes) opens the
//  editor menu, or with |quickSave| saves at once
async function postMessage(c, subject, lines, menuKey, label, quickSave = false) {
    await c.type('p');
    await c.expect(/write a message/);
    dump(c, `${label}: editor`);
    await c.ret(); //  To: keep "All"
    await c.type(subject);
    await c.ret();
    for (let i = 0; i < lines.length; ++i) {
        await c.type(lines[i]);
        if (i < lines.length - 1) {
            await c.ret();
        }
    }
    await c.settle();
    dump(c, `${label}: written`);
    await c.keys(menuKey);
    if (quickSave) {
        return;
    }
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
    await c.ret();
    await c.expect(/list messages/);

    await c.type('a');
    await c.expect(/Pick a message area/);
    dump(c, 'area list');
    await c.ret();
    await c.expect(/list messages/);
    dump(c, 'message menu, area picked');

    //  saved through the editor menu opened with F1 (ESC on an Atari),
    //  saving with S
    const machine = c.k.machine;
    await postMessage(
        c,
        `Hello from ${machine}`,
        [`First line from ${machine}.`, 'Second line, typed at 40 columns, wraps here.'],
        c.k.menu,
        `post (${c.k.menuKey})`
    );
    await c.type('s');
    await expectThrough(c, /list messages/);
    dump(c, `message menu after post (${c.k.menuKey})`);

    if (c.k.quickSave) {
        //  CTRL S saves at once (ATASCII)
        await postMessage(
            c,
            'Second post via CTRL S',
            ['Quick save works too.', 'Bye.'],
            c.k.quickSave,
            'post (CTRL S)',
            true
        );
        await expectThrough(c, /list messages/);
        dump(c, 'message menu after post (CTRL S)');
    } else {
        //  the same with a real ESC byte, saving with RETURN (save is first)
        await postMessage(
            c,
            'Second post via ESC',
            ['Escape works too.', 'Bye.'],
            [ESC],
            'post (ESC)'
        );
        await c.ret();
        await expectThrough(c, /list messages/);
        dump(c, 'message menu after post (ESC)');
    }

    await c.type('l');
    await expectThrough(c, /Hello from/);
    dump(c, 'message list');

    await c.ret();
    await c.expect(/read a message/);
    await c.expect(/wraps here/);
    dump(c, 'read message 1');

    await c.type('n');
    await c.expect(/(Escape|Quick save) works too/);
    dump(c, 'read message 2 (N)');

    await c.type('p');
    await c.expect(/First line from/);
    dump(c, 'read message 1 again (P)');

    await c.type('?');
    await c.expect(/reader keys/);
    dump(c, 'reader help');
    await c.ret();
    await c.expect(/read a message/);

    //  reply, quoting a line
    await c.type('r');
    await c.expect(/write a message/);
    await c.expect(/RE: Hello/);
    dump(c, 'reply: editor');
    await c.ret(); //  To: the author
    await c.ret(); //  Subject: RE: ...
    await c.settle();
    await c.keys(c.k.menu);
    await c.expect(/quote/);
    dump(c, 'reply: editor menu');
    await c.type('q');
    await c.expect(/Quote: RETURN/);
    dump(c, 'reply: quote builder');
    await c.ret(); //  the first line
    await c.settle();
    dump(c, 'reply: quote builder, a line picked');
    await c.keys(c.k.menu);
    await c.settle();
    await c.type(`A reply from ${c.k.machine}.`);
    await c.settle();
    dump(c, 'reply: written');
    await c.keys(c.k.menu);
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
        `\nbytes=${c.dataBytes} esc=${c.escBytes} escBefore1Bto1F=${c.badEsc} modelErrors=${c.errors.length} closedByServer=${c.closed}`
    );
    c.errors.slice(0, 10).forEach(e => console.log(`  ${e}`));
    c.sock.destroy();
    process.exitCode =
        c.errors.length || c.badEsc || (c.emu.escIsError && c.escBytes) ? 1 : 0;
}

module.exports = { Caller, dump };

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(2);
    });
}

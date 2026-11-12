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
//                           [--term PETSCII] [--walk full|connect|messages]
//
//  --walk connect stops after the first menu (to check a route in); --term ''
//  sends no terminal type (a dedicated PETSCII listener does not need one).
//
//  --walk messages logs in and goes through the message menus instead of
//  who's online and last callers: conference and area lists, a post saved
//  through the editor menu opened with F1, a second one opened with a real
//  ESC byte, the message list, reading, the reader's help, a reply with a
//  quoted line, and back out to log off. Run it once per fresh instance:
//  it expects an area holding only what it posts.
//
const net = require('net');
const paths = require('path');

const root = paths.resolve(__dirname, '../..');
const { PetsciiScreen } = require(paths.join(root, 'test/term_petscii_screens.js'));
const { encode, Controls } = require(paths.join(root, 'core/term/petscii/charset.js'));

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
        term: 'PETSCII',
        walk: 'full',
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 2) {
        out[argv[i].replace(/^--/, '')] = argv[i + 1];
    }
    out.port = parseInt(out.port, 10);
    return out;
}

class Caller {
    constructor({ port, term }) {
        this.term = term;
        this.screen = new PetsciiScreen(40, 25, { row: 0, col: 0 });
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
                this._send([IAC, WILL, NAWS, IAC, SB, NAWS, 0, 40, 0, 25, IAC, SE]);
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
        for (let r = 0; r < 25; ++r) {
            let line = '';
            for (let c = 0; c < 40; ++c) {
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
        this._send(encode(text, 'lower'));
        await sleep(150);
    }

    async key(byte) {
        this._send([byte]);
        await sleep(150);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dump(caller, label) {
    const bar = '+' + '-'.repeat(40) + '+';
    console.log(
        `\n[${label}]  (cursor ${caller.screen.row + 1},${caller.screen.col + 1})`
    );
    console.log(bar);
    caller
        .text()
        .split('\n')
        .forEach(l => console.log('|' + l.padEnd(40) + '|'));
    console.log(bar);
}

async function main() {
    const args = parseArgs();
    const c = new Caller(args);

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
    //  anything the system shows on its own in between (an achievement
    //  popup on a return call, say) waits for a key
    for (let i = 0; i < 5 && !/main menu/.test(c.text()); ++i) {
        await c.expect(/main menu|press a key/);
        if (!/main menu/.test(c.text())) {
            dump(c, 'interstitial');
            await c.key(Controls.return);
            await c.settle();
        }
    }
    await c.expect(/main menu/);
    dump(c, 'main menu');

    if ('messages' === args.walk) {
        await messagesWalk(c);
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
const ESC = 0x1b;

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
    process.exitCode = c.errors.length || c.escBytes ? 1 : 0;
}

module.exports = { Caller, dump };

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(2);
    });
}

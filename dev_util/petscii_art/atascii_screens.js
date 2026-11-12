'use strict';

//
//  The ATASCII starter screens (#593), as readable descriptions.
//
//  build.js turns each into an .ata file in misc/atascii_starter/. These are
//  plain placeholders, meant to be replaced by real ATASCII art: a title
//  band, a few lines of text, some line graphics, and the MCI codes each
//  menu in misc/menu_templates/atascii.in.hjson needs. They are the PETSCII
//  starter's screens (./screens.js) made over for an Atari: 40x24, one
//  colour, Atari keys.
//
//  A screen is a list of rows, top to bottom, at most 24 rows of at most 39
//  columns (no row reaches the 40th; see build.js). In a row:
//
//      {rvs} {/rvs}          inverse video on / off (an Atari screen has
//                            one colour: inverse is all there is)
//      %VM1 %ET1 ...         MCI codes, typed as text
//
//  Only characters ATASCII draws exactly may be used, and none whose byte is
//  a control byte (the arrows, the escape glyph, the clear-screen arrow and
//  the two triangles would need ESC quoting, which SyncTERM misdraws for some
//  of them): build.js refuses anything else. The bottom right cell is never
//  drawn: no row reaches the last column.
//
//  |prompt|, |part| and |pad| mean what they mean in ./screens.js.
//

const { WIDTH, visibleLength, spaces, at, row, center } = require('./screens.js');

const HEIGHT = 24;

//  a horizontal line (ATASCII's line graphic)
const rule = (col = 3, length = 36) => at(col, '─'.repeat(length));

//  the title band at the top of each screen: 39 columns, as no row reaches
//  the last column (see build.js)
const band = title => {
    const left = ' ENiGMA BBS';
    const right = `${title} `;
    return `{rvs}${left}${spaces(WIDTH - 1 - left.length - right.length)}${right}{/rvs}`;
};

//  a short notice: band, heading, a few lines, closing rule
const notice = (title, heading, lines) => [
    band(title),
    '',
    at(3, heading),
    rule(),
    '',
    ...lines.map(line => at(3, line)),
    '',
    rule(),
];

//  |count| empty rows
const blank = count => Array(count).fill('');

//  a conference or area list: VM1 is the list, TL2 the focused item's
//  description; columns match the VM1 itemFormat in theme.hjson
const list = (title, heading, context) => [
    band(title),
    '',
    at(3, heading),
    context ? at(3, context) : '',
    rule(),
    at(3, '%VM1'),
    ...blank(11),
    rule(),
    at(3, '%TL2'),
    '',
    at(3, 'RETURN picks, Q or ESC goes back'),
];

//  an editor footer: a rule, a row of views, a row of hints; padded, as the
//  footers replace each other in the same rows
const footer = (views, hints) => ({
    prompt: true,
    pad: true,
    rows: [rule(2, 38), views, at(2, hints)],
});

//  a help screen: [key, what it does] rows
const help = (title, keys) => [
    band(title),
    '',
    ...keys.map(([key, what]) => at(2, `${key.padEnd(18)}${what}`)),
    '',
    rule(2, 38),
    at(2, 'Press a key to go back.'),
];

//  the line between menu items and their hint
const menuHint = ['Arrow keys and RETURN, or the', 'letter in brackets.'];

const Screens = {
    //  the stock connect menu (telnetConnected) and atasciiConnected both use it
    CONNECT: [
        band('connected'),
        '',
        '',
        center('Welcome, Atari caller!'),
        '',
        center('This board speaks ATASCII.'),
        '',
        center('─'.repeat(28)),
        '',
        center('These screens are placeholders.'),
        center('Artists: replace them with your'),
        center('own ATASCII art. See the docs.'),
        '',
        center('─'.repeat(28)),
        '',
        center('One moment...'),
    ],

    AMATRIX: [
        band('login'),
        '',
        at(3, '%BN'),
        rule(),
        '',
        at(3, 'Welcome! Pick one:'),
        '',
        at(6, '%VM1'),
        '',
        '',
        '',
        rule(),
        ...menuHint.map(t => at(3, t)),
        ...blank(7),
        center('Placeholder art: artists wanted!'),
    ],

    AAPPLY: notice('apply', 'New users', [
        'New accounts cannot be made from an',
        'ATASCII terminal yet.',
        '',
        'Please call again with an ANSI',
        'terminal to apply, then log in here',
        'with your new account.',
    ]),

    ALOGIN: [
        band('login'),
        '',
        at(3, 'Log in'),
        rule(),
        '',
        at(3, 'User name:'),
        at(3, '%ET1'),
        '',
        at(3, 'Password:'),
        at(3, '%ET2'),
        '',
        rule(),
    ],

    A2FAOTP: [
        band('two-factor'),
        '',
        at(3, 'Two-factor login'),
        rule(),
        '',
        at(3, 'Enter the code from your'),
        at(3, 'authenticator app:'),
        '',
        at(3, '%ET1'),
        '',
        rule(),
    ],

    ATOONODE: notice('login', 'Already logged in', [
        'That account is already on another',
        'node. Please try again later.',
    ]),

    ALOCKED: notice('login', 'Account locked', [
        'Too many failed logins. Please try',
        'again later, or ask the sysop.',
    ]),

    ADISABLED: notice('login', 'Account disabled', [
        'This account has been disabled.',
        'Please contact the sysop.',
    ]),

    AINACTIVE: notice('login', 'Account not active yet', [
        'This account has not been activated',
        'yet. Please wait for the sysop, or',
        'check your email.',
    ]),

    AMAIN: [
        band('main menu'),
        '',
        at(3, 'Hello, %UN'),
        rule(),
        '',
        at(6, '%VM1'),
        '',
        '',
        '',
        '',
        rule(),
        ...menuHint.map(t => at(3, t)),
    ],

    //  columns match the VM1 itemFormat in misc/atascii_starter/theme.hjson
    ALASTCALL: [
        band('last callers'),
        '',
        at(2, 'User           From      When'),
        rule(2, 38),
        at(2, '%VM1'),
        ...blank(9),
        rule(2, 38),
    ],

    AWHOSON: [
        band("who's online"),
        '',
        at(2, 'Node User            Doing'),
        rule(2, 38),
        at(2, '%VM1'),
        ...blank(9),
        rule(2, 38),
    ],

    //
    //  Messages
    //
    AMSGMENU: [
        band('messages'),
        '',
        at(3, 'Conference %MC(26)'),
        at(3, 'Area       %MA(26)'),
        rule(),
        '',
        at(6, '%VM1'),
        ...blank(5),
        rule(),
        ...menuHint.map(t => at(3, t)),
    ],

    //  conference and area lists: VM1 lists, TL2 describes the one in focus
    AMSGCONF: list('conferences', 'Join a conference'),
    AMSGAREA: list('message areas', 'Pick a message area', 'Conference %MC(24)'),

    //  columns match the VM1 itemFormat in misc/atascii_starter/theme.hjson
    AMSGLIST: [
        band('messages'),
        '',
        at(2, '%MA(38)'),
        rule(2, 38),
        at(2, `  # ${'Subject'.padEnd(20)}From`),
        at(2, '%VM1'),
        ...blank(13),
        rule(2, 38),
        at(2, '%TL10'),
        '',
        at(2, 'RETURN read, P post, Q or ESC back'),
    ],

    //
    //  The full-screen editor, for reading (V) and writing (E). Its screen is
    //  put together from a header, the body below it, and one of the footers
    //  below that. Both headers are six rows, so one body serves both; the
    //  body's last row is where the footer starts. On 24 rows the body has
    //  one row less than the PETSCII starter's.
    //
    AMSGEHDR: [
        band('write a message'),
        at(2, 'From %TL1'),
        at(2, '  To %ET2'),
        at(2, 'Subj %ET3'),
        at(7, '%TL4'),
        rule(2, 38),
    ],

    AMSGVHDR: [
        band('read a message'),
        at(2, 'From %TL1'),
        at(2, '  To %TL2'),
        at(2, 'Subj %TL3'),
        row([2, 'Date %TL5'], [25, '#%TL6/%TL7']),
        rule(2, 38),
    ],

    //  MT1 is 14 rows high (theme.hjson); the 15th row is the footer's first
    AMSGBODY: {
        part: true,
        rows: [at(2, '%MT1'), ...blank(14)],
    },

    AMSGEFTR: footer(
        row([2, 'ESC: save, discard, help...'], [31, '%SB1']),
        'CTRL S saves; RETURN new line'
    ),
    AMSGEMFT: footer(at(2, '%HM1'), 'A letter or RETURN; ESC to go back'),
    AMSGVFTR: footer(at(2, '%HM1'), 'CTRL W/Z page, N P R, ? help, Q'),
    //  find: the editor's and reader's footer while asking what to find
    AMSGFIND: footer(at(2, 'Find %ET1'), 'RETURN finds; ESC cancels, clears'),

    //  quote builder: drawn below the header, views offset by its height.
    //  VM3 (6 rows, theme.hjson) ends on row 20, above the footer's first
    //  row (21): the list blanks its rows when it is redrawn, which happens
    //  after the footer is back, so it must not reach the footer. Its closing
    //  rule is on the footer's rule row.
    AMSGQUOT: {
        prompt: true,
        pad: true,
        rows: [
            at(2, 'Quote: RETURN adds a line, ESC ends'),
            at(2, '%MT1'),
            ...blank(5),
            rule(2, 38),
            at(2, '%VM3'),
            ...blank(5),
            rule(2, 38),
            '',
        ],
    },

    AMSGEHLP: help('editor keys', [
        ['arrow keys', 'move'],
        ['CTRL E or CTRL X', 'end of the line'],
        ['CTRL V', 'insert or overwrite'],
        ['BACKSPACE', 'delete left'],
        ['RETURN', 'new line'],
        ['CTRL W / CTRL Z', 'page up / page down'],
        ['ESC', 'menu: save, discard,'],
        ['', 'quote, help'],
        ['CTRL S', 'save'],
        ['CTRL F', 'find (goes to the'],
        ['', 'first match)'],
        ['CTRL Y', 'delete the line'],
        ['CTRL A', 'edit the subject'],
        ['CTRL O', 'this help'],
    ]),

    AMSGVHLP: help('reader keys', [
        ['arrow up/down', 'scroll'],
        ['CTRL W / CTRL Z', 'page up / page down'],
        ['arrow left/right', 'pick from the menu'],
        ['RETURN', 'do what is picked'],
        ['N', 'next message'],
        ['P', 'previous message'],
        ['R', 'reply'],
        ['Q or ESC', 'back to the list'],
        ['CTRL F', 'find'],
        ['CTRL N / CTRL P', 'next / previous'],
        ['', 'match'],
        ['CTRL F, then ESC', 'stop finding'],
    ]),

    //
    //  New-message scan (new_scan): asked after login, or picked from the
    //  message menu. ANEWSCAN shows TL1, the scan's status line, and the
    //  pause prompt below it when the scan is done; areas with something new
    //  are listed in ANEWMSGS (columns as AMSGLIST).
    //
    ANSCONF: [
        band('new scan'),
        '',
        at(3, 'Look for new messages?'),
        rule(),
        '',
        at(6, '%TM1'),
        '',
        rule(),
        at(3, 'Y or N, or arrow keys and RETURN.'),
    ],

    ANEWSCAN: [band('new scan'), '', at(3, 'New messages'), rule(), at(3, '%TL1'), ''],

    ANEWMSGS: [
        band('new messages'),
        '',
        at(2, '%MA(38)'),
        rule(2, 38),
        at(2, `  # ${'Subject'.padEnd(20)}From`),
        at(2, '%VM1'),
        ...blank(13),
        rule(2, 38),
        at(2, '%TL10'),
        at(2, 'RETURN read, Q next area, X stop,'),
        at(2, 'M mark all read, P post'),
    ],

    AMSGNOACC: notice('messages', 'No access', [
        'You cannot post in this area.',
        'Pick another area, or ask the',
        'sysop.',
    ]),

    AMSGNORPL: notice('messages', 'No reply', [
        'This message is from someone',
        'without an account here, so',
        'there is nobody to reply to.',
    ]),

    ALOGOFF: [
        band('log off'),
        '',
        '',
        center('Thanks for calling!'),
        '',
        center('Come back soon.'),
        '',
    ],

    //  the system's own idle logoff menu (idleLogoff) uses this name
    IDLELOG: notice('idle', 'Idle too long', [
        'No keys pressed for a while, so the',
        'board is hanging up. Goodbye!',
    ]),

    //  pause prompts: this tree's (atasciiPause) and the system's (pause)
    APAUSE: { prompt: true, rows: [at(3, '-- press a key --')] },
    pause: { prompt: true, rows: [at(3, '-- press a key --')] },
};

module.exports = { Screens, WIDTH, HEIGHT, visibleLength };

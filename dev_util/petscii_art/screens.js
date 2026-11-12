'use strict';

//
//  The PETSCII starter screens (#593), as readable descriptions.
//
//  build.js turns each into a .seq file in misc/petscii_starter/. These are
//  plain placeholders, meant to be replaced by real PETSCII art: a title
//  band, a few lines of text, some line graphics, and the MCI codes each
//  menu in misc/menu_templates/petscii.in.hjson needs.
//
//  A screen is a list of rows, top to bottom, at most 25 rows of at most 40
//  columns. In a row:
//
//      {white} {yellow} ...  set the colour (charset.js Colors names)
//      {rvs} {/rvs}          reverse video on / off
//      %VM1 %ET1 ...         MCI codes, typed as text
//
//  Only characters that PETSCII's lower/upper set draws exactly may be used;
//  build.js refuses anything else. The bottom right cell is never drawn.
//
//  |prompt: true| marks prompt art: drawn where the cursor is, with no clear
//  screen, no character set switch and no RETURN at the end.
//
//  |part: true| marks a part of a screen drawn below another (the editor's
//  body under its header): no clear screen and no character set switch, but
//  a RETURN after every row, so that its height counts them all.
//
//  |pad: true| fills every row out to the full width with spaces, for art
//  drawn over other art in the same rows (the editor's footers, which take
//  turns at the bottom of the screen).
//

const WIDTH = 40;

//  visible length: everything but {tags}
const visibleLength = s => s.replace(/\{[^}]*\}/g, '').length;

const spaces = n => ' '.repeat(Math.max(0, n));

//  |text| starting at column |col| (1-based)
const at = (col, text) => spaces(col - 1) + text;

//  a row of [col, text] pieces, each starting at its own column (1-based)
const row = (...pieces) =>
    pieces.reduce(
        (out, [col, text]) => out + spaces(col - 1 - visibleLength(out)) + text,
        ''
    );

//  |text| centred on the screen
const center = text => spaces(Math.floor((WIDTH - visibleLength(text)) / 2)) + text;

//  a horizontal line
const rule = (col = 3, length = 36, color = 'grey') =>
    at(col, `{${color}}${'─'.repeat(length)}`);

//  the full width title band at the top of each screen
const band = title => {
    const left = ' ENiGMA BBS';
    const right = `${title} `;
    return `{lightBlue}{rvs}${left}${spaces(WIDTH - left.length - right.length)}${right}{/rvs}`;
};

//  a short notice: band, heading, a few lines, closing rule
const notice = (title, heading, lines) => [
    band(title),
    '',
    at(3, `{white}${heading}`),
    rule(),
    '',
    ...lines.map(line => at(3, `{lightGrey}${line}`)),
    '',
    rule(),
];

//  a conference or area list: VM1 is the list, TL2 the focused item's
//  description; columns match the VM1 itemFormat in theme.hjson
const list = (title, heading, context) => [
    band(title),
    '',
    at(3, `{white}${heading}`),
    context ? at(3, `{grey}${context}`) : '',
    rule(),
    at(3, '{lightGrey}%VM1'),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    rule(),
    at(3, '{grey}%TL2'),
    '',
    at(3, '{darkGrey}RETURN picks, Q or F1 goes back'),
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
    ...keys.map(([key, what]) => at(2, `{white}${key.padEnd(18)}{lightGrey}${what}`)),
    '',
    rule(2, 38),
    at(2, '{lightBlue}Press a key to go back.'),
];

const Screens = {
    //  the stock connect menu (telnetConnected) and petsciiConnected both use it
    CONNECT: [
        band('connected'),
        '',
        '',
        center('{white}Welcome, Commodore caller!'),
        '',
        center('{lightGrey}This board speaks PETSCII.'),
        '',
        center('{grey}────────────────────────────'),
        '',
        center('{yellow}These screens are placeholders.'),
        center('{lightGrey}Artists: replace them with your'),
        center('{lightGrey}own PETSCII art. See the docs.'),
        '',
        center('{grey}────────────────────────────'),
        '',
        center('{lightBlue}One moment...'),
    ],

    PMATRIX: [
        band('login'),
        '',
        at(3, '{white}%BN'),
        rule(),
        '',
        at(3, '{lightGrey}Welcome! Pick one:'),
        '',
        at(6, '{cyan}%VM1'),
        '',
        '',
        '',
        rule(),
        at(3, '{darkGrey}Cursor keys and RETURN, or the'),
        at(3, '{darkGrey}letter in brackets.'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        center('{darkGrey}Placeholder art: artists wanted!'),
    ],

    PAPPLY: notice('apply', 'New users', [
        'New accounts cannot be made from a',
        'PETSCII terminal yet.',
        '',
        'Please call again with an ANSI',
        'terminal to apply, then log in here',
        'with your new account.',
    ]),

    PLOGIN: [
        band('login'),
        '',
        at(3, '{white}Log in'),
        rule(),
        '',
        at(3, '{lightGrey}User name:'),
        at(3, '{cyan}%ET1'),
        '',
        at(3, '{lightGrey}Password:'),
        at(3, '{cyan}%ET2'),
        '',
        rule(),
    ],

    P2FAOTP: [
        band('two-factor'),
        '',
        at(3, '{white}Two-factor login'),
        rule(),
        '',
        at(3, '{lightGrey}Enter the code from your'),
        at(3, '{lightGrey}authenticator app:'),
        '',
        at(3, '{cyan}%ET1'),
        '',
        rule(),
    ],

    PTOONODE: notice('login', 'Already logged in', [
        'That account is already on another',
        'node. Please try again later.',
    ]),

    PLOCKED: notice('login', 'Account locked', [
        'Too many failed logins. Please try',
        'again later, or ask the sysop.',
    ]),

    PDISABLED: notice('login', 'Account disabled', [
        'This account has been disabled.',
        'Please contact the sysop.',
    ]),

    PINACTIVE: notice('login', 'Account not active yet', [
        'This account has not been activated',
        'yet. Please wait for the sysop, or',
        'check your email.',
    ]),

    PMAIN: [
        band('main menu'),
        '',
        at(3, '{white}Hello, {yellow}%UN'),
        rule(),
        '',
        at(6, '{cyan}%VM1'),
        '',
        '',
        '',
        '',
        rule(),
        at(3, '{darkGrey}Cursor keys and RETURN, or the'),
        at(3, '{darkGrey}letter in brackets.'),
    ],

    //  columns match the VM1 itemFormat in misc/petscii_starter/theme.hjson
    PLASTCALL: [
        band('last callers'),
        '',
        at(2, '{white}User           From      When'),
        rule(2, 38),
        at(2, '{lightGrey}%VM1'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        rule(2, 38),
    ],

    PWHOSON: [
        band("who's online"),
        '',
        at(2, '{white}Node User            Doing'),
        rule(2, 38),
        at(2, '{lightGrey}%VM1'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        rule(2, 38),
    ],

    //
    //  Messages
    //
    PMSGMENU: [
        band('messages'),
        '',
        at(3, '{grey}Conference {white}%MC(26)'),
        at(3, '{grey}Area       {white}%MA(26)'),
        rule(),
        '',
        at(6, '{cyan}%VM1'),
        '',
        '',
        '',
        '',
        '',
        rule(),
        at(3, '{darkGrey}Cursor keys and RETURN, or the'),
        at(3, '{darkGrey}letter in brackets.'),
    ],

    //  conference and area lists: VM1 lists, TL2 describes the one in focus
    PMSGCONF: list('conferences', 'Join a conference'),
    PMSGAREA: list('message areas', 'Pick a message area', 'Conference {white}%MC(24)'),

    //  columns match the VM1 itemFormat in misc/petscii_starter/theme.hjson
    PMSGLIST: [
        band('messages'),
        '',
        at(2, '{white}%MA(38)'),
        rule(2, 38),
        at(2, `{grey}  # ${'Subject'.padEnd(20)}From`),
        at(2, '{lightGrey}%VM1'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        rule(2, 38),
        at(2, '{lightGrey}%TL10'),
        '',
        at(2, '{darkGrey}RETURN read, P post, Q or F1 back'),
    ],

    //
    //  The full-screen editor, for reading (V) and writing (E). Its screen is
    //  put together from a header, the body below it, and one of the footers
    //  below that. Both headers are six rows, so one body serves both; the
    //  body's last row is where the footer starts.
    //
    PMSGEHDR: [
        band('write a message'),
        at(2, '{grey}From {white}%TL1'),
        at(2, '{grey}  To {cyan}%ET2'),
        at(2, '{grey}Subj {cyan}%ET3'),
        at(7, '{lightRed}%TL4'),
        rule(2, 38),
    ],

    PMSGVHDR: [
        band('read a message'),
        at(2, '{grey}From {white}%TL1'),
        at(2, '{grey}  To {white}%TL2'),
        at(2, '{grey}Subj {yellow}%TL3'),
        row(
            [2, '{grey}Date {lightGrey}%TL5'],
            [25, '{grey}#{white}%TL6{grey}/{white}%TL7']
        ),
        rule(2, 38),
    ],

    //  MT1 is 15 rows high (theme.hjson); the 16th row is the footer's first
    PMSGBODY: {
        part: true,
        rows: [at(2, '{lightGrey}%MT1'), ...Array(15).fill('')],
    },

    PMSGEFTR: footer(
        row([2, '{lightBlue}F1{grey}: save, discard, help...'], [31, '{white}%SB1']),
        '{darkGrey}RETURN new line, DEL deletes'
    ),
    PMSGEMFT: footer(at(2, '{cyan}%HM1'), '{darkGrey}A letter or RETURN; F1 to go back'),
    PMSGVFTR: footer(at(2, '{cyan}%HM1'), '{darkGrey}F3/F5 page, N P R, ? help, Q quit'),
    //  find: the editor's and reader's footer while asking what to find
    PMSGFIND: footer(
        at(2, '{white}Find {cyan}%ET1'),
        '{darkGrey}RETURN finds; F1 cancels, clears'
    ),

    //  quote builder: drawn below the header, views offset by its height
    PMSGQUOT: {
        prompt: true,
        pad: true,
        rows: [
            at(2, '{white}Quote: RETURN adds a line, F1 ends'),
            at(2, '{lightGrey}%MT1'),
            '',
            '',
            '',
            '',
            '',
            rule(2, 38),
            at(2, '{cyan}%VM3'),
            '',
            '',
            '',
            '',
            '',
            '',
            rule(2, 38),
            '',
        ],
    },

    PMSGEHLP: help('editor keys', [
        ['cursor keys', 'move'],
        ['HOME', 'start of the line'],
        ['CLR (shift HOME)', 'end of the line'],
        ['INST', 'insert or overwrite'],
        ['DEL', 'delete left'],
        ['RETURN', 'new line'],
        ['F3 / F5', 'page up / page down'],
        ['F1', 'menu: save, discard,'],
        ['', 'quote, help'],
        ['CTRL F', 'find (goes to the'],
        ['', 'first match)'],
        ['CTRL Y', 'delete the line'],
        ['CTRL A', 'edit the subject'],
        ['CTRL O', 'this help'],
    ]),

    PMSGVHLP: help('reader keys', [
        ['cursor up/down', 'scroll'],
        ['F3 / F5', 'page up / page down'],
        ['cursor left/right', 'pick from the menu'],
        ['RETURN', 'do what is picked'],
        ['N', 'next message'],
        ['P', 'previous message'],
        ['R', 'reply'],
        ['Q or F1', 'back to the list'],
        ['CTRL F', 'find'],
        ['CTRL G / CTRL P', 'next / previous'],
        ['', 'match'],
        ['CTRL F, then F1', 'stop finding'],
    ]),

    //
    //  New-message scan (new_scan): asked after login, or picked from the
    //  message menu. PNEWSCAN shows TL1, the scan's status line, and the
    //  pause prompt below it when the scan is done; areas with something new
    //  are listed in PNEWMSGS (columns as PMSGLIST).
    //
    PNSCONF: [
        band('new scan'),
        '',
        at(3, '{white}Look for new messages?'),
        rule(),
        '',
        at(6, '{cyan}%TM1'),
        '',
        rule(),
        at(3, '{darkGrey}Y or N, or cursor keys and RETURN.'),
    ],

    PNEWSCAN: [
        band('new scan'),
        '',
        at(3, '{white}New messages'),
        rule(),
        at(3, '{lightGrey}%TL1'),
        '',
    ],

    PNEWMSGS: [
        band('new messages'),
        '',
        at(2, '{white}%MA(38)'),
        rule(2, 38),
        at(2, `{grey}  # ${'Subject'.padEnd(20)}From`),
        at(2, '{lightGrey}%VM1'),
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        rule(2, 38),
        at(2, '{lightGrey}%TL10'),
        at(2, '{darkGrey}RETURN read, Q next area, X stop,'),
        at(2, '{darkGrey}M mark all read, P post'),
    ],

    PMSGNOACC: notice('messages', 'No access', [
        'You cannot post in this area.',
        'Pick another area, or ask the',
        'sysop.',
    ]),

    PMSGNORPL: notice('messages', 'No reply', [
        'This message is from someone',
        'without an account here, so',
        'there is nobody to reply to.',
    ]),

    PLOGOFF: [
        band('log off'),
        '',
        '',
        center('{white}Thanks for calling!'),
        '',
        center('{lightBlue}Come back soon.'),
        '',
    ],

    //  the system's own idle logoff menu (idleLogoff) uses this name
    IDLELOG: notice('idle', 'Idle too long', [
        'No keys pressed for a while, so the',
        'board is hanging up. Goodbye!',
    ]),

    //  pause prompts: this tree's (petsciiPause) and the system's (pause)
    PPAUSE: { prompt: true, rows: [at(3, '{lightBlue}-- press a key --')] },
    pause: { prompt: true, rows: [at(3, '{lightBlue}-- press a key --')] },
};

module.exports = { Screens, WIDTH };

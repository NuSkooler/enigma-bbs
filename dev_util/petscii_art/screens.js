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

const WIDTH = 40;

//  visible length: everything but {tags}
const visibleLength = s => s.replace(/\{[^}]*\}/g, '').length;

const spaces = n => ' '.repeat(Math.max(0, n));

//  |text| starting at column |col| (1-based)
const at = (col, text) => spaces(col - 1) + text;

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

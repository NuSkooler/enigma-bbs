'use strict';

//
//  The RIP starter's button screens (#989), one per menu of
//  misc/menu_templates/rip.in.hjson that has one. build.js turns each into
//  misc/rip_starter/<name>.rip (buttons drawn with RIPscrip) and <name>.ans
//  (the same choices as plain ANSI text). See build.js for the layout.
//
//  For each screen:
//      name    art name (the files are <name>.rip and <name>.ans)
//      title   drawn in the header bar
//      help    lines of text under the header
//      buttons [ key, label ]: the button sends |key| when clicked, and the
//              menu binds the same key, so typing it does the same thing.
//              The key is one character, sent without Enter.
//      status  the last line: [ text, MCI code ]; the code is filled in by
//              ENiGMA (the cursor ends after it)
//
const Screens = [
    {
        name: 'RMATRIX',
        title: 'WELCOME',
        help: [
            'Log in, apply for an account, or log off.',
            'Click a button, or press the letter in brackets.',
        ],
        buttons: [
            ['L', 'Login'],
            ['A', 'Apply'],
            ['G', 'Log Off'],
        ],
        status: ['Welcome to ', '%BN'],
    },
    {
        name: 'RMAIN',
        title: 'MAIN MENU',
        help: [
            'Read and post messages, see who is on, or log off.',
            'Click a button, or press the letter in brackets.',
        ],
        buttons: [
            ['M', 'Messages'],
            ['W', "Who's Online"],
            ['L', 'Last Callers'],
            ['G', 'Goodbye'],
        ],
        status: ['Logged in as ', '%UN'],
    },
    {
        name: 'RMSGMENU',
        title: 'MESSAGES',
        help: [
            'Read, post, change area, or scan for new messages.',
            'Click a button, or press the letter in brackets.',
        ],
        buttons: [
            ['L', 'List / Read'],
            ['P', 'Post'],
            ['C', 'Change Area'],
            ['N', 'New Scan'],
            ['Q', 'Back'],
        ],
        status: ['Message area: ', '%MA'],
    },
];

module.exports = { Screens };

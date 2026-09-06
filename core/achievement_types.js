/* jslint node: true */
'use strict';

//
//  The kinds of trigger an achievement may declare.
//
//  Its own module because core/achievement.js captures the user database and
//  the theme layer at load time -- see the note at the top of
//  test/achievement.test.js -- and core/config/achievement_schema.js needs
//  nothing but these three strings. Requiring the whole of achievement.js to
//  read them would drag all of that onto the configuration path, including
//  "oputil.js config validate", which deliberately opens no databases at all.
//
module.exports = {
    //  compared against the new absolute value of the stat
    UserStatSet: 'userStatSet',

    //  compared against the increment from a single event
    UserStatInc: 'userStatInc',

    //  compared against the running total after an increment
    UserStatIncNewVal: 'userStatIncNewVal',
};

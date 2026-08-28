'use strict';

//  Create the drill's sysop. AreaFix replies are addressed to a real user, and
//  operator notifications need somewhere to land.

const paths = require('path');

const ROOT = paths.join(__dirname, '..', '..', '..');
const DRILL = process.argv[2];

const configModule = require(paths.join(ROOT, 'core/config.js'));
const db = require(paths.join(ROOT, 'core/database.js'));
const logger = require(paths.join(ROOT, 'core/logger.js'));

configModule.Config.create(
    paths.join(DRILL, 'config', 'config.hjson'),
    { hotReload: false },
    err => {
        if (err) {
            console.error('config:', err.message);
            process.exit(1);
        }

        logger.init();
        db.initializeDatabases(dbErr => {
            if (dbErr) {
                console.error('db:', dbErr.message);
                process.exit(1);
            }

            const User = require(paths.join(ROOT, 'core/user.js'));
            const user = new User();
            user.username = 'drillop';
            user.create({ password: 'drillpassword' }, userErr => {
                if (userErr) {
                    console.error('user:', userErr.message);
                    process.exit(1);
                }
                console.log(`sysop: id=${user.userId} ${user.username}`);
                process.exit(0);
            });
        });
    }
);

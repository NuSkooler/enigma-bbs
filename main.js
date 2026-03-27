#!/usr/bin/env node

/* jslint node: true */
'use strict';

/*
	ENiGMA½ entry point

	If this file does not run directly, ensure it's executable:
	> chmod u+x main.js
*/

//  WORKAROUND: Load sharp before sqlite3 to prevent segfault on ARM64 Linux
//  with 16KB memory pages (e.g. Raspberry Pi 4/5). libvips and SQLite's native
//  allocator conflict when sharp is loaded after sqlite3 has executed a query.
//  See: https://github.com/NuSkooler/enigma-bbs/issues/620
try { require('sharp'); } catch (e) { /* sharp is optional */ }

require('./core/bbs.js').main();

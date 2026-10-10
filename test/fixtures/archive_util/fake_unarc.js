'use strict';

//  Stands in for `unarc list --json ARCHIVE`: prints the archive's contents,
//  which hold the listing to emit, and noise on stderr as unarc may
const fs = require('fs');

const archivePath = process.argv[process.argv.length - 1];
process.stderr.write('  Detected 2 volumes\n');
process.stdout.write(fs.readFileSync(archivePath));
process.exitCode = archivePath.endsWith('.fail') ? 1 : 0;

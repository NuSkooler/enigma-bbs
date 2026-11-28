'use strict';

//
//  Version strings that other systems parse -- FTN kludges and tearlines,
//  QWK and Blue Wave packets, dropfiles, the SSH ident, MRC, bbs_link -- carry
//  the plain release version (package.json), never the git describe string
//  core/version.js getVersion() builds for local display
//  (0.7.0-14-gabc1234-dirty). Those formats have specs and length limits that
//  other software relies on.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const paths = require('path');

const releaseVersion = require('../package.json').version;

const Root = paths.join(__dirname, '..');

//  Modules that write a version into something another system reads
const WireModules = [
    'core/ftn_util.js',
    'core/misc_util.js',
    'core/scanner_tossers/ftn_bso.js',
    'core/qwk_mail_packet.js',
    'core/bluewave_mail_packet.js',
    'core/dropfile.js',
    'core/bbs_link.js',
    'core/servers/login/ssh.js',
    'core/servers/chat/mrc_multiplexer.js',
];

//  The suffix git describe adds: -<n>-g<hash>, -g<hash>, -dirty
const DescribeSuffix = /-g[0-9a-f]{4,}|-dirty/;

describe('Version strings in interop formats', function () {
    it('no module that writes an interop format uses the git describe string', function () {
        for (const rel of WireModules) {
            const file = paths.join(Root, rel);
            if (!fs.existsSync(file)) {
                continue;
            }
            const src = fs.readFileSync(file, 'utf8');
            assert.ok(
                !/\bgetVersion\s*\(/.test(src),
                `${rel} calls getVersion(); interop formats use getReleaseVersion()`
            );
        }
    });

    describe('FTN', function () {
        const ftnUtil = require('../core/ftn_util.js');
        const { getCleanEnigmaVersion } = require('../core/misc_util.js');

        it('the tearline carries the release version', function () {
            const tear = ftnUtil.getTearLine();
            assert.ok(tear.startsWith(`--- ENiGMA 1/2 v${releaseVersion} (`), tear);
            assert.ok(!DescribeSuffix.test(tear), tear);
        });

        it('the PID (FSC-0046) carries the clean release version', function () {
            const pid = ftnUtil.getProductIdentifier();
            assert.ok(pid.startsWith(`ENiGMA1/2 ${getCleanEnigmaVersion()} (`), pid);
            assert.ok(!DescribeSuffix.test(pid), pid);
        });

        it('the Via line (FRL-1005) carries the clean release version', function () {
            const via = ftnUtil.getVia('21:1/100@fsxnet');
            assert.ok(via.endsWith(` ENiGMA1/2 ${getCleanEnigmaVersion()}`), via);
            assert.ok(!DescribeSuffix.test(via), via);
        });

        it('the clean version is the release version, with no describe suffix', function () {
            const clean = getCleanEnigmaVersion();
            assert.ok(!DescribeSuffix.test(clean), clean);
            assert.ok(!/\s/.test(clean), clean);
        });
    });
});

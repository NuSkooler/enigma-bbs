/* jslint node: true */
'use strict';

//  make_image.sh needs xdftool (amitools) to build an image, which CI does not
//  have; these cover what it checks before it gets that far. The full build is
//  a manual test, see misc/amiga_door/image/README.md.

const { strict: assert } = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hjson = require('hjson');

const SCRIPT = path.join(__dirname, '../misc/amiga_door/image/make_image.sh');
const TEMPLATE = path.join(__dirname, '../misc/menu_templates/doors.in.hjson');

function run(args, env = {}) {
    return spawnSync('bash', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, env),
    });
}

describe('amiga_door make_image.sh', function () {
    let dir;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amiga-image-'));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('prints usage when given too few arguments', () => {
        const r = run([]);
        assert.equal(r.status, 2);
        assert.match(r.stderr + r.stdout, /make_image\.sh/);
    });

    it('says so when xdftool is not available', () => {
        const r = run([path.join(dir, 'a.hdf'), dir], {
            XDFTOOL: '/nonexistent/xdftool',
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /xdftool not found/);
    });

    it('refuses a door directory that is not one', () => {
        const r = run([path.join(dir, 'a.hdf'), path.join(dir, 'nope')], {
            XDFTOOL: 'true',
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /not a directory/);
    });

    it('refuses to replace an image without -f', () => {
        const img = path.join(dir, 'exists.hdf');
        fs.writeFileSync(img, 'x');
        const r = run([img, dir], { XDFTOOL: 'true' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /exists/);
        assert.equal(fs.readFileSync(img, 'utf8'), 'x');
    });

    it('hands xdftool the shim, library, startup sequence and every door file', () => {
        const door = path.join(dir, 'My Door');
        fs.mkdirSync(path.join(door, 'data'), { recursive: true });
        fs.writeFileSync(path.join(door, 'door.xim'), 'x');
        fs.writeFileSync(path.join(door, 'data', 'scores.dat'), '');

        //  a stand-in xdftool that records its arguments, one per line
        const log = path.join(dir, 'args.txt');
        const fake = path.join(dir, 'fake-xdftool.sh');
        fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n`, {
            mode: 0o755,
        });

        const r = run(['-s', '2M', path.join(dir, 'out.hdf'), door], { XDFTOOL: fake });
        assert.equal(r.status, 0, r.stderr);

        const args = fs.readFileSync(log, 'utf8').split('\n');
        assert.ok(args.includes('size=2M'));
        assert.ok(args.includes('C/axshim'));
        assert.ok(args.includes('Libs/AEDoor.library'));
        assert.ok(args.includes('S/Startup-Sequence'));
        assert.ok(args.includes('Doors/My Door/door.xim'));
        assert.ok(args.includes('Doors/My Door/data'));
        assert.ok(args.includes('Doors/My Door/data/scores.dat'));
    });

    it("-w copies ARexx from the sysop's Workbench disk", () => {
        const door = path.join(dir, 'Kickboxing');
        fs.mkdirSync(door, { recursive: true });
        fs.writeFileSync(path.join(door, 'KickBox.Rexx'), '/* */');
        const adf = path.join(dir, 'Workbench3.1.adf');
        fs.writeFileSync(adf, '');

        //  a stand-in xdftool: records its arguments and "reads" empty files
        const log = path.join(dir, 'wb-args.txt');
        const fake = path.join(dir, 'fake-wb-xdftool.sh');
        fs.writeFileSync(
            fake,
            `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\n` +
                'while [ $# -gt 0 ]; do\n' +
                '  if [ "$1" = read ]; then : > "$3"; shift 3; else shift; fi\n' +
                'done\n',
            { mode: 0o755 }
        );

        const r = run(['-w', adf, path.join(dir, 'wb.hdf'), door], { XDFTOOL: fake });
        assert.equal(r.status, 0, r.stderr);
        const args = fs.readFileSync(log, 'utf8').split('\n');
        assert.ok(args.includes(adf));
        for (const f of [
            'System/RexxMast',
            'Libs/rexxsyslib.library',
            'Libs/rexxsupport.library',
            'Libs/mathieeedoubbas.library',
            'Rexxc/RX',
            'C/Avail',
            'C/Delete',
            'Doors/Kickboxing/KickBox.Rexx',
        ]) {
            assert.ok(args.includes(f), `${f} not handed to xdftool`);
        }
    });

    it('-w refuses a Workbench disk that is not there', () => {
        const r = run(['-w', path.join(dir, 'nope.adf'), path.join(dir, 'b.hdf'), dir], {
            XDFTOOL: 'true',
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /no such Workbench disk/);
    });
});

describe('amiga_door menu template', () => {
    it('parses and offers an amiga_door example from the doors menu', () => {
        const menus = hjson.parse(fs.readFileSync(TEMPLATE, 'utf8')).menus;
        const entry = menus.doorMyGameAmiga;
        assert.equal(entry.module, 'amiga_door');
        for (const key of ['name', 'image', 'door']) {
            assert.equal(typeof entry.config[key], 'string');
        }
        assert.ok(
            menus.doorsMainMenu.submit.some(s => s.action === '@menu:doorMyGameAmiga')
        );
    });
});

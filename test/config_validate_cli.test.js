'use strict';

const { strict: assert } = require('assert');
const { execFileSync } = require('child_process');
const paths = require('path');
const fs = require('fs');
const os = require('os');

//
//  The validator itself is covered in config_validate.test.js; this covers the
//  wiring around it, which nothing else does: argument parsing, the initConfig
//  export oputil depends on, the output format, and -- the part a script or a
//  systemd ExecStartPre actually depends on -- the exit code.
//
//  Spawns the real command rather than calling into it, because the things
//  most likely to break here (a missing export, a mis-parsed flag, an exit
//  code set on the wrong path) are exactly the things an in-process call would
//  paper over.
//
const OPUTIL = paths.join(__dirname, '..', 'oputil.js');
const REPO_ROOT = paths.join(__dirname, '..');

//  Written as JSON, which HJSON accepts. Quoteless HJSON values run to the
//  end of the line, so a one-line fixture would swallow its own closing
//  braces -- and this is not the place to test the parser.
function runValidate(config, args = [], achievements) {
    const dir = fs.mkdtempSync(paths.join(os.tmpdir(), 'enigma-validate-'));

    if (achievements) {
        //
        //  general.achievementFile is resolved against paths.config, not
        //  against wherever config.hjson happens to live -- that is what the
        //  running board does, and oputil has to agree with it. So a temporary
        //  achievements file needs paths.config pointed here too, exactly as a
        //  sysop with a relocated config directory would.
        //
        config = Object.assign({}, config, {
            paths: Object.assign({}, config.paths, { config: dir }),
        });

        fs.writeFileSync(
            paths.join(dir, 'achievements.hjson'),
            JSON.stringify(achievements, null, 4),
            'utf8'
        );
    }

    fs.writeFileSync(
        paths.join(dir, 'config.hjson'),
        JSON.stringify(config, null, 4),
        'utf8'
    );

    const argv = [
        OPUTIL,
        'config',
        'validate',
        '--config',
        `${dir}${paths.sep}`,
        ...args,
    ];

    try {
        return {
            code: 0,
            output: execFileSync(process.execPath, argv, {
                encoding: 'utf8',
                cwd: REPO_ROOT,
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        };
    } catch (e) {
        return { code: e.status, output: `${e.stdout || ''}${e.stderr || ''}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('oputil config validate', () => {
    it('says so, and succeeds, when there is nothing wrong', () => {
        const { code, output } = runValidate({ general: { boardName: 'Test' } });

        assert.equal(code, 0);
        assert.match(output, /no problems found/);
    });

    it('reports a misspelled key and still succeeds on warnings alone', () => {
        //  an unrecognised key may perfectly well belong to a mod, so warnings
        //  must not fail the command
        const { code, output } = runValidate({ general: { boardnam: 'Test' } });

        assert.equal(code, 0);
        assert.match(output, /1 issue \(1 warning\)/);
        assert.match(output, /unknown key "boardnam" -- did you mean "boardName"\?/);
    });

    it('exits non-zero when there is an error', () => {
        const { code, output } = runValidate({ general: { maxConnections: 'lots' } });

        assert.notEqual(code, 0);
        assert.match(output, /expected number, got string/);
    });

    it('emits no escape sequences when its output is not a terminal', () => {
        //  piping to a file or to tee is how an operator sends a report to
        //  somebody; it must not arrive full of escapes
        const { output } = runValidate({ general: { boardnam: 'Test' } });
        assert.ok(!output.includes('\x1b['), 'expected no ANSI escapes when piped');
    });

    it('ignores an unresolved @environment spec unless asked to check it', () => {
        const config = { general: { maxConnections: '@environment:NOPE_UNSET:number' } };

        const quiet = runValidate(config);
        assert.equal(quiet.code, 0);
        assert.match(quiet.output, /no problems found/);

        const checked = runValidate(config, ['--check-env']);
        assert.notEqual(checked.code, 0);
        assert.match(checked.output, /did not resolve/);
    });

    it('reports a broken cross-reference', () => {
        const { code, output } = runValidate({
            fileBase: { areas: { mine: { name: 'Mine', storageTags: ['nope'] } } },
        });

        assert.notEqual(code, 0);
        assert.match(
            output,
            /storage tag "nope" is not defined in fileBase\.storageTags/
        );
    });

    it('checks achievements.hjson as well, and names the file it means', () => {
        //
        //  The board will not start on a broken achievements.hjson either, so
        //  "check before you restart" has to cover it. Both reports name their
        //  own file, since there is now more than one.
        //
        const { code, output } = runValidate(
            { general: { boardName: 'Test', achievementFile: 'achievements.hjson' } },
            [],
            {
                enabled: true,
                achievements: {
                    a: { type: 'userStatSet', statname: 'login_count', match: {} },
                },
            }
        );

        assert.equal(code, 0); //  a warning alone is not a failure
        assert.match(output, /config\.hjson: no problems found/);
        assert.match(output, /achievements\.hjson: 1 issue \(1 warning\)/);
        assert.match(output, /did you mean "statName"\?/);
    });

    it('fails the command when only achievements.hjson has an error', () => {
        const { code, output } = runValidate(
            { general: { boardName: 'Test', achievementFile: 'achievements.hjson' } },
            [],
            {
                enabled: true,
                achievements: {
                    a: {
                        type: 'userStatSet',
                        statName: 'login_count',
                        match: { 5: { title: 'T', text: 'x', points: 'ten' } },
                    },
                },
            }
        );

        assert.notEqual(code, 0);
        assert.match(output, /config\.hjson: no problems found/);
        assert.match(output, /expected number, got string/);
    });

    it('warns, rather than fails, when achievements.hjson cannot be read', () => {
        //
        //  module_util.js logs a warning and carries on when a system module
        //  fails to initialise, so a board with an unreadable
        //  achievements.hjson still starts -- it simply has no achievements.
        //  Failing the command here would break a systemd ExecStartPre over
        //  something the board itself shrugs off.
        //
        const { code, output } = runValidate({
            general: { boardName: 'Test', achievementFile: 'not-here.hjson' },
        });

        assert.equal(code, 0);
        assert.match(output, /not-here\.hjson/);
        assert.match(output, /achievements will be unavailable/);
    });

    it('says everything exactly once', () => {
        //  Config.create() also runs the validator through the loader hook;
        //  oputil opts out of that report so it does not say it all twice
        const { output } = runValidate({ general: { boardnam: 'Test' } });
        assert.equal(output.split('boardnam').length - 1, 2); //  path line + message
    });
});

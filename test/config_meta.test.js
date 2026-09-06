'use strict';

const { strict: assert } = require('assert');
const _ = require('lodash');

const Meta = require('../core/config/meta');
const { buildSchema, resolvePath } = require('../core/config/schema');

//
//  The corpus is hand written, and every constraint in it is an *error* rather
//  than a warning: an enum or a range that is wrong does not merely annoy, it
//  makes "oputil.js config validate" exit non-zero on a correct board and
//  breaks whatever systemd unit or script depends on that. So the bar for
//  adding one is evidence from the code that reads the setting, and these are
//  the mechanical parts of that bar.
//

describe('config metadata corpus', () => {
    const defaults = require('../core/config_default')();

    const entries = Object.entries(Meta).filter(([path]) => !path.includes('*'));

    it('never constrains a setting outside the value ENiGMA½ ships', () => {
        //
        //  The single most damaging mistake available here: declare an enum or
        //  a range that the default itself violates, and every stock
        //  configuration reports an error on first run.
        //
        const broken = [];

        entries.forEach(([path, entry]) => {
            const value = _.get(defaults, path);
            if (undefined === value) {
                return;
            }

            if (entry.enum && !entry.enum.includes(value)) {
                broken.push(`${path}: default ${JSON.stringify(value)} not in enum`);
            }
            if (undefined !== entry.min && value < entry.min) {
                broken.push(`${path}: default ${value} below min ${entry.min}`);
            }
            if (undefined !== entry.max && value > entry.max) {
                broken.push(`${path}: default ${value} above max ${entry.max}`);
            }
        });

        assert.deepEqual(broken, [], broken.join('; '));
    });

    it('declares a range that makes sense', () => {
        const broken = entries
            .filter(
                ([, e]) => undefined !== e.min && undefined !== e.max && e.min > e.max
            )
            .map(([p]) => p);

        assert.deepEqual(broken, []);
    });

    it('never declares an empty or duplicated enum', () => {
        const broken = entries
            .filter(([, e]) => e.enum)
            .filter(
                ([, e]) => 0 === e.enum.length || new Set(e.enum).size !== e.enum.length
            )
            .map(([p]) => p);

        assert.deepEqual(broken, []);
    });

    it('writes descriptions that say more than the key name already does', () => {
        const weak = entries
            .filter(([, e]) => undefined !== e.description)
            .filter(([path, e]) => {
                const key = path.split('.').pop().toLowerCase();
                const description = e.description.trim();
                return (
                    description.length < 12 ||
                    description.toLowerCase().replace(/[^a-z]/g, '') === key
                );
            })
            .map(([p]) => p);

        assert.deepEqual(weak, [], `descriptions that add nothing: ${weak}`);
    });
});

// ─── Values copied out of the code they belong to ────────────────────────────

//
//  meta.js is loaded on the configuration path, so it copies these rather than
//  requiring the modules that own them -- otplib alone costs a third of a
//  second. A copy is only acceptable with something watching it.
//
describe('config metadata copied from code', () => {
    it('offers exactly the two factor methods the code implements', () => {
        const { OTPTypes } = require('../core/user_2fa_otp');

        assert.deepEqual(
            [...Meta['users.twoFactorAuth.method'].enum].sort(),
            Object.values(OTPTypes).sort()
        );
    });

    it('offers exactly the log levels bunyan accepts', () => {
        //  the rotatingFile block is handed to bunyan verbatim
        const levels = Object.keys(require('bunyan').levelFromName);

        [
            'logging.rotatingFile.level',
            'contentServers.web.logging.rotatingFile.level',
        ].forEach(path => {
            assert.deepEqual([...Meta[path].enum].sort(), [...levels].sort(), path);
        });
    });
});

// ─── Completeness ────────────────────────────────────────────────────────────

describe('config metadata completeness', () => {
    it('bounds every port in the configuration', () => {
        //
        //  A new server arriving without bounds is the likely way this corpus
        //  rots, and an unbounded port is the one that silently fails to bind.
        //
        const schema = buildSchema();
        const defaults = require('../core/config_default')();
        const ports = [];

        (function walk(value, path) {
            if (value && 'object' === typeof value && !Array.isArray(value)) {
                return Object.entries(value).forEach(([k, v]) =>
                    walk(v, path ? `${path}.${k}` : k)
                );
            }
            if ('number' === typeof value && /(^|\.)[a-z]*port$/i.test(path)) {
                ports.push(path);
            }
        })(defaults, '');

        assert.ok(ports.length > 10, `expected many ports, found ${ports.length}`);

        const unbounded = ports.filter(path => {
            const node = resolvePath(schema, path);
            return !node || 1 !== node.min || 65535 !== node.max;
        });

        assert.deepEqual(unbounded, [], `ports with no bounds: ${unbounded}`);
    });
});

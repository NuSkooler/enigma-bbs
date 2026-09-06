'use strict';

const { strict: assert } = require('assert');
const paths = require('path');
const fs = require('fs');
const hjson = require('hjson');

const { buildAchievementSchema } = require('../core/config/achievement_schema');
const { validateConfig } = require('../core/config/validate');
const { IssueCodes } = require('../core/config/issue');

const schema = buildAchievementSchema();

//  achievements.hjson has no defaults object, so the file the sysop wrote and
//  the effective configuration are the same thing.
const validate = config => validateConfig(config, config, schema);

const codesIn = issues => issues.map(i => `${i.path}:${i.code}`);

describe('achievements schema against the shipped file', () => {
    //
    //  Unlike config.hjson, config/achievements.hjson is tracked -- .gitignore
    //  is "config/*" followed by "!config/achievements.hjson" -- so this runs
    //  against the real thing rather than a fixture, and would fail if a new
    //  achievement used a field the schema does not know.
    //
    const shipped = hjson.parse(
        fs.readFileSync(paths.join(__dirname, '../config/achievements.hjson'), 'utf8')
    );

    it('reports nothing', () => {
        assert.deepEqual(validate(shipped), []);
    });

    it('is actually being read, not silently skipped', () => {
        assert.ok(Object.keys(shipped.achievements).length > 10);
    });
});

describe('achievements schema', () => {
    const anAchievement = extra =>
        Object.assign(
            {
                type: 'userStatSet',
                statName: 'login_count',
                match: { 5: { title: 'T', text: 'x', points: 1 } },
            },
            extra
        );

    it('catches a misspelled field on an achievement', () => {
        //
        //  The failure this exists for: Achievement.factory() returns
        //  undefined for an entry it cannot make sense of and the achievement
        //  simply never fires, with nothing logged either way.
        //
        const issues = validate({
            achievements: { a: { type: 'userStatSet', statname: 'login_count' } },
        });

        assert.deepEqual(codesIn(issues), ['achievements.a.statname:unknownKey']);
        assert.equal(issues[0].suggestion, 'statName');
    });

    it('catches a misspelled field on a tier', () => {
        const issues = validate({
            achievements: {
                a: anAchievement({ match: { 5: { title: 'T', txt: 'x', points: 1 } } }),
            },
        });

        assert.deepEqual(codesIn(issues), ['achievements.a.match.5.txt:unknownKey']);
        assert.equal(issues[0].suggestion, 'text');
    });

    it('catches a type nothing implements', () => {
        const issues = validate({
            achievements: { a: anAchievement({ type: 'userStatsSet' }) },
        });

        assert.equal(issues.length, 1);
        assert.equal(issues[0].code, IssueCodes.InvalidEnum);
    });

    it('offers exactly the achievement types the code implements', () => {
        //  referenced rather than copied; this only proves the reference works
        const AchievementTypes = require('../core/achievement_types');
        const types = schema.children.achievements.value.children.type.enum;

        assert.deepEqual([...types].sort(), Object.values(AchievementTypes).sort());
    });

    it('catches a tier whose points are not a number', () => {
        const issues = validate({
            achievements: {
                a: anAchievement({
                    match: { 5: { title: 'T', text: 'x', points: 'ten' } },
                }),
            },
        });

        assert.deepEqual(codesIn(issues), ['achievements.a.match.5.points:typeMismatch']);
    });

    it('catches a misspelled top-level key', () => {
        const issues = validate({ enabled: true, achievments: {} });

        assert.deepEqual(codesIn(issues), ['achievments:unknownKey']);
        assert.equal(issues[0].suggestion, 'achievements');
    });

    it('says nothing about the tags a sysop chooses', () => {
        assert.deepEqual(
            validate({ achievements: { whatever_they_called_it: anAchievement() } }),
            []
        );
    });

    it('says nothing about the thresholds a sysop chooses', () => {
        assert.deepEqual(
            validate({
                achievements: {
                    a: anAchievement({
                        match: {
                            1: { title: 'A', text: 'a', points: 1 },
                            9999: { title: 'B', text: 'b', points: 2 },
                        },
                    }),
                },
            }),
            []
        );
    });

    it('accepts art at all three levels it is read from', () => {
        //
        //  core/achievement.js resolves art most-specific-first: the tier, then
        //  the achievement, then the file's own top level. Two of those three
        //  appear in neither the shipped file nor the documentation, so a key
        //  set closed on what ships would have called them typos.
        //
        const art = { localHeader: 'h', globalFooter: 'f' };

        assert.deepEqual(
            validate({
                art,
                achievements: {
                    a: anAchievement({
                        art,
                        match: { 5: { title: 'T', text: 'x', points: 1, art } },
                    }),
                },
            }),
            []
        );
    });

    it('catches a misspelled art frame', () => {
        const issues = validate({ art: { localHeadr: 'h' } });

        assert.deepEqual(codesIn(issues), ['art.localHeadr:unknownKey']);
        assert.equal(issues[0].suggestion, 'localHeader');
    });
});

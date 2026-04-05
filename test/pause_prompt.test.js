'use strict';

const { strict: assert } = require('assert');

const { paginate } = require('../core/art.js');
const configModule = require('../core/config.js');

//  MenuModule requires a non-trivial config at construction time.
const MENU_MODULE_CONFIG = {
    debug: { assertsEnabled: false },
    menus: { cls: false },
};

function makeMenuModule(menuConfigPatch = {}) {
    //  Install a richer config mock
    const previous = configModule._pushTestConfig(MENU_MODULE_CONFIG);

    const { MenuModule } = require('../core/menu_module.js');

    const menuConfig = Object.assign(
        {
            config: {},
            art: null,
        },
        menuConfigPatch
    );

    const client = {
        term: { termWidth: 80, termHeight: 25 },
        log: { warn: () => {}, debug: () => {}, trace: () => {} },
        currentTheme: { prompts: {} },
    };

    const instance = new MenuModule({
        menuName: 'testMenu',
        menuConfig,
        client,
    });

    configModule._popTestConfig(previous);

    return instance;
}

// ─── art.paginate ─────────────────────────────────────────────────────────────

describe('art.paginate', () => {
    it('returns single page when content fits within termHeight', () => {
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
        const result = paginate(lines, { termHeight: 25 });
        assert.equal(result.pages.length, 1);
        assert.equal(result.hasAbsolutePositioning, false);
    });

    it('splits into multiple pages when content exceeds termHeight', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
        const result = paginate(lines, { termHeight: 25 });
        assert.ok(result.pages.length > 1, 'expected multiple pages');
        assert.equal(result.hasAbsolutePositioning, false);
    });

    it('uses termHeight-1 as page size', () => {
        //  24 lines with termHeight=25 → page size 24 → should fit on one page
        const lines = Array.from({ length: 24 }, (_, i) => `line${i}`).join('\n');
        const result = paginate(lines, { termHeight: 25 });
        assert.equal(result.pages.length, 1);
    });

    it('detects absolute positioning escape sequences', () => {
        const artWithGoto = 'some art\x1b[10;5Hmore art';
        const result = paginate(artWithGoto, { termHeight: 25 });
        assert.equal(result.pages.length, 1);
        assert.equal(result.hasAbsolutePositioning, true);
    });

    it('detects f-form absolute positioning', () => {
        const artWithF = 'line1\x1b[5;1fline2';
        const result = paginate(artWithF, { termHeight: 25 });
        assert.equal(result.hasAbsolutePositioning, true);
    });

    it('preserves all lines across pages', () => {
        const lineCount = 48;
        const lines = Array.from({ length: lineCount }, (_, i) => `line${i}`);
        const input = lines.join('\n');
        const result = paginate(input, { termHeight: 25 });

        const rejoined = result.pages.join('\n');
        assert.equal(rejoined, input);
    });

    it('defaults to termHeight 25 when options are not provided', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
        const result = paginate(lines);
        assert.ok(result.pages.length > 1);
    });

    it('accepts Buffer input', () => {
        const lines = Array.from({ length: 5 }, (_, i) => `line${i}`).join('\n');
        const buf = Buffer.from(lines, 'binary');
        const result = paginate(buf, { termHeight: 25 });
        assert.equal(result.pages.length, 1);
    });
});

// ─── MenuModule.shouldPause / getPauseMode ────────────────────────────────────

describe('MenuModule.shouldPause / getPauseMode', () => {
    it('shouldPause returns false when pause is not set', () => {
        const m = makeMenuModule({ config: {} });
        assert.equal(m.shouldPause(), false);
    });

    it('shouldPause returns true for pause: true', () => {
        const m = makeMenuModule({ config: { pause: true } });
        assert.equal(m.shouldPause(), true);
    });

    it('shouldPause returns true for pause: "end"', () => {
        const m = makeMenuModule({ config: { pause: 'end' } });
        assert.equal(m.shouldPause(), true);
    });

    it('shouldPause returns true for pause: "pageBreak"', () => {
        const m = makeMenuModule({ config: { pause: 'pageBreak' } });
        assert.equal(m.shouldPause(), true);
    });

    it('getPauseMode returns "end" by default', () => {
        const m = makeMenuModule({ config: { pause: true } });
        assert.equal(m.getPauseMode(), 'end');
    });

    it('getPauseMode returns "pageBreak" when configured', () => {
        const m = makeMenuModule({ config: { pause: 'pageBreak' } });
        assert.equal(m.getPauseMode(), 'pageBreak');
    });

    it('shouldPause returns true for pause: "<promptId>" shorthand', () => {
        const m = makeMenuModule({ config: { pause: 'myFancyPause' } });
        assert.equal(m.shouldPause(), true);
    });

    it('getPauseMode returns "end" for pause: "<promptId>" shorthand', () => {
        const m = makeMenuModule({ config: { pause: 'myFancyPause' } });
        assert.equal(m.getPauseMode(), 'end');
    });
});

// ─── MenuModule._resolvePromptName ────────────────────────────────────────────

describe('MenuModule._resolvePromptName', () => {
    it('returns "pause" for type "end" with no pausePrompt config', () => {
        const m = makeMenuModule({ config: {} });
        assert.equal(m._resolvePromptName('end'), 'pause');
    });

    it('returns "pausePage" for type "page" with no pausePrompt config', () => {
        const m = makeMenuModule({ config: {} });
        assert.equal(m._resolvePromptName('page'), 'pausePage');
    });

    it('returns the string value for both types when pausePrompt is a string', () => {
        const m = makeMenuModule({ config: { pausePrompt: 'myPause' } });
        assert.equal(m._resolvePromptName('end'), 'myPause');
        assert.equal(m._resolvePromptName('page'), 'myPause');
    });

    it('returns per-type names when pausePrompt is an object', () => {
        const m = makeMenuModule({
            config: { pausePrompt: { end: 'endPrompt', page: 'pagePrompt' } },
        });
        assert.equal(m._resolvePromptName('end'), 'endPrompt');
        assert.equal(m._resolvePromptName('page'), 'pagePrompt');
    });

    it('falls back to system default when object only specifies one type', () => {
        const m = makeMenuModule({ config: { pausePrompt: { end: 'endOnly' } } });
        assert.equal(m._resolvePromptName('end'), 'endOnly');
        assert.equal(m._resolvePromptName('page'), 'pausePage'); //  fallback
    });

    it('uses pause value as prompt name for type "end" (shorthand)', () => {
        const m = makeMenuModule({ config: { pause: 'myFancyPause' } });
        assert.equal(m._resolvePromptName('end'), 'myFancyPause');
    });

    it('shorthand pause prompt does not affect page type (uses system default)', () => {
        const m = makeMenuModule({ config: { pause: 'myFancyPause' } });
        assert.equal(m._resolvePromptName('page'), 'pausePage');
    });

    it('pausePrompt takes precedence over pause shorthand', () => {
        const m = makeMenuModule({
            config: { pause: 'shorthand', pausePrompt: 'explicit' },
        });
        assert.equal(m._resolvePromptName('end'), 'explicit');
    });
});

// ─── MenuModule._applyPausePosition ──────────────────────────────────────────

describe('MenuModule._applyPausePosition', () => {
    it('returns base position when no pausePosition is configured', () => {
        const m = makeMenuModule({ config: {} });
        const result = m._applyPausePosition({ row: 20, col: 1 });
        assert.deepEqual(result, { row: 20, col: 1 });
    });

    it('overrides row when pausePosition.row is set', () => {
        const m = makeMenuModule({ config: { pausePosition: { row: 24 } } });
        const result = m._applyPausePosition({ row: 20, col: 1 });
        assert.equal(result.row, 24);
        assert.equal(result.col, 1); //  unchanged
    });

    it('overrides col when pausePosition.col is set', () => {
        const m = makeMenuModule({ config: { pausePosition: { col: 40 } } });
        const result = m._applyPausePosition({ row: 20, col: 1 });
        assert.equal(result.row, 20); //  unchanged
        assert.equal(result.col, 40);
    });

    it('overrides both row and col', () => {
        const m = makeMenuModule({
            config: { pausePosition: { row: 24, col: 5 } },
        });
        const result = m._applyPausePosition({ row: 20, col: 1 });
        assert.deepEqual(result, { row: 24, col: 5 });
    });

    it('does not mutate the base position object', () => {
        const m = makeMenuModule({ config: { pausePosition: { row: 24 } } });
        const base = { row: 20, col: 1 };
        m._applyPausePosition(base);
        assert.equal(base.row, 20); //  original unchanged
    });
});

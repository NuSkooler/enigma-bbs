'use strict';

//  ENiGMA½
const FrameClock = require('./frame_clock.js');
const { emulationOf } = require('./term/index.js');
const { LAYER_NAME: RIP_LAYER } = require('./term/rip');

//  deps
const _ = require('lodash');

//
//  animation_config.js -- what decides whether something animates for a
//  client, and how config durations are read. Shared by the %AV animation
//  view (core/animation_view.js) and animated menu items (focusItemFrames,
//  core/menu_view.js), so both follow the same switches:
//
//  - menus.animations.enabled: false is a hard off (owner, 2026-11-21); a
//    menu's own config.animations: false turns off just that menu, and
//    cannot turn them back on
//  - plain ANSI sessions only: not PETSCII, ATASCII, or the RIP layer
//  - menus.animations.minFrameIntervalMs: the frame clock's floor
//

const DEFAULT_FRAME_INTERVAL_MS = 100;
const DEFAULT_MIN_FRAME_INTERVAL_MS = FrameClock.DEFAULT_MIN_FRAME_INTERVAL_MS;

//  menus.animations, read when used (config.js is not captured at load)
function animationsConfig() {
    const getConfig = require('./config.js').get;
    const config = _.isFunction(getConfig) ? getConfig() : null;
    return _.get(config, 'menus.animations') || {};
}

function minFrameIntervalMs() {
    const ms = Number(animationsConfig().minFrameIntervalMs);
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_MIN_FRAME_INTERVAL_MS;
}

//  On for |client|'s current menu? The system switch is a hard off (owner,
//  2026-11-21); a menu can only turn its own animations off, not back on
function animationsEnabled(client) {
    if (false === animationsConfig().enabled) {
        return false;
    }
    const perMenu = _.get(client, 'currentMenuModule.menuConfig.config.animations');
    return false !== perMenu;
}

//  Plain ANSI sessions only: not PETSCII, ATASCII, or the RIP layer
function sessionAnimates(client) {
    //  late: theme.js requires (through ViewController) the views
    const { getSessionEmulation } = require('./theme.js');
    if ('ansi' !== getSessionEmulation(client)) {
        return false;
    }
    const emulation = emulationOf(_.get(client, 'term'));
    return !(_.isFunction(emulation.hasLayer) && emulation.hasLayer(RIP_LAYER));
}

//  Both of the above: may |client| be shown animation now?
function clientAnimates(client) {
    return animationsEnabled(client) && sessionAnimates(client);
}

//  |client|'s frame clock, with the configured floor applied
function frameClockFor(client) {
    return FrameClock.getFrameClock(client, { minIntervalMs: minFrameIntervalMs() });
}

//
//  A duration from config: a finite number of ms >= 0 (or a string of
//  one). undefined: not set (missing, null, false or ""); NaN: set, but
//  not a duration (true, -1, "fast", an object).
//
function parseMs(value) {
    if (undefined === value || null === value || false === value || '' === value) {
        return undefined;
    }
    if ('number' === typeof value) {
        return Number.isFinite(value) && value >= 0 ? value : NaN;
    }
    if ('string' === typeof value && /^\s*\d+(\.\d+)?\s*$/.test(value)) {
        return Number(value);
    }
    return NaN;
}

exports.DEFAULT_FRAME_INTERVAL_MS = DEFAULT_FRAME_INTERVAL_MS;
exports.DEFAULT_MIN_FRAME_INTERVAL_MS = DEFAULT_MIN_FRAME_INTERVAL_MS;
exports.animationsConfig = animationsConfig;
exports.minFrameIntervalMs = minFrameIntervalMs;
exports.animationsEnabled = animationsEnabled;
exports.sessionAnimates = sessionAnimates;
exports.clientAnimates = clientAnimates;
exports.frameClockFor = frameClockFor;
exports.parseMs = parseMs;

'use strict';
//  Build a throwaway ENiGMA instance (config + menus + data dirs) under a
//  directory, the way `oputil.js config new` does, without prompts.
//  Usage: node make_instance.js [instanceDir] [telnetPort] [secondPort [secondFirstMenu]]
//  Defaults: .work/instance beside this file, port 47991 (127.0.0.1 only).
//  With secondPort, a named telnet listener "second" is added on that port
//  (loginServers.telnet.listeners), entering secondFirstMenu (default "login",
//  the stock login prompt) instead of telnetConnected.
//  Refuses to write into a non-empty directory it did not create (marker file).
//
//  Flags (anywhere on the line):
//    --petscii                 opt in to the PETSCII starter menus and theme,
//                              as "config new" does on Yes (#593). The instance
//                              then gets a themes directory of its own
//                              (<instanceDir>/themes: the stock theme and
//                              the starter theme copied), so nothing is added
//                              to the checkout's art/themes.
//    --atascii                 the same for the ATASCII starter; with
//                              --petscii too, the connect menu gets both
//                              branches, as "config new" writes them on
//                              Yes to both questions.
//    --rip                     the RIP starter (#989): the RIP menu file and a
//                              TE[rip] branch, with the starter's art copied
//                              into an art directory of the instance's own
//                              (<instanceDir>/art: a copy of art/general and
//                              the starter art), so nothing is added to the
//                              checkout's art/general.
//    --second-emulation=NAME   give the second listener "emulation: NAME"
const fs = require('fs');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');

const root = paths.resolve(__dirname, '../..');
const MARKER = '.term_harness_instance';
const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const petscii = flags.includes('--petscii');
const atascii = flags.includes('--atascii');
const rip = flags.includes('--rip');
//  the starters asked for, by emulation name
const starterNames = [petscii && 'petscii', atascii && 'atascii', rip && 'rip'].filter(
    Boolean
);
const secondEmulationFlag = flags.find(f => f.startsWith('--second-emulation='));
const secondEmulation = secondEmulationFlag && secondEmulationFlag.split('=')[1];
const [
    instDir = paths.join(__dirname, '.work', 'instance'),
    portArg = '47991',
    secondPortArg,
    secondFirstMenu = 'login',
] = args.filter(a => !a.startsWith('--'));
const inst = paths.resolve(instDir);
const parsePort = arg => {
    const p = parseInt(arg, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
        console.error(`bad port: ${arg}`);
        process.exit(1);
    }
    return p;
};
const port = parsePort(portArg);
const secondPort = undefined === secondPortArg ? undefined : parsePort(secondPortArg);
if (secondPort === port) {
    console.error('second port must differ from the main port');
    process.exit(1);
}

if (fs.existsSync(inst)) {
    if (!fs.statSync(inst).isDirectory()) {
        console.error(`${inst} exists and is not a directory`);
        process.exit(1);
    }
    if (fs.readdirSync(inst).length > 0 && !fs.existsSync(paths.join(inst, MARKER))) {
        console.error(
            `refusing to write into ${inst}: not empty and not created by this tool (no ${MARKER})`
        );
        process.exit(1);
    }
}
fs.mkdirSync(inst, { recursive: true });
fs.writeFileSync(
    paths.join(inst, MARKER),
    `created by dev_util/term_harness/make_instance.js\nport=${port}\n`
);

for (const d of [
    'menus',
    'db',
    'db/mods',
    'logs',
    'drop',
    'file_base',
    'mail',
    'security',
]) {
    fs.mkdirSync(paths.join(inst, d), { recursive: true });
}

const {
    ConfigIncludeKeys,
    Starters,
    applyStarterConfig,
    copyStarterTheme,
    copyStarterArt,
    addConnectBranches,
} = require(paths.join(root, 'core/oputil/oputil_config.js'));
const defaultConfig = require(paths.join(root, 'core/config_default'))();
const template = hjson.rt.parse(
    fs.readFileSync(paths.join(root, 'misc/config_template.in.hjson'), 'utf8')
);
const direct = {};
ConfigIncludeKeys.forEach(k => _.set(direct, k, _.get(defaultConfig, k)));
const config = _.mergeWith(template, direct);

config.general.boardName = 'Harness Test';
config.general.prettyBoardName = '|08Harness Test';
config.messageConferences.local = {
    name: 'Local',
    desc: 'Local Areas',
    sort: 1,
    default: true,
    areas: {
        general: { name: 'General', desc: 'General chit-chat', sort: 1, default: true },
    },
};
config.logging.rotatingFile.level = 'debug';
config.loginServers.telnet = { enabled: true, port, address: '127.0.0.1' };
if (undefined !== secondPort) {
    config.loginServers.telnet.listeners = {
        second: { port: secondPort, address: '127.0.0.1', firstMenu: secondFirstMenu },
    };
    if (secondEmulation) {
        config.loginServers.telnet.listeners.second.emulation = secondEmulation;
    }
}
config.loginServers.ssh.enabled = false;
config.loginServers.webSocket.ws.enabled = false;
config.loginServers.webSocket.wss.enabled = false;
_.set(config, 'contentServers.web.http.enabled', false);
_.set(config, 'contentServers.web.https.enabled', false);

config.paths = Object.assign(config.paths || {}, {
    logs: paths.join(inst, 'logs') + '/',
    db: paths.join(inst, 'db') + '/',
    modsDb: paths.join(inst, 'db/mods') + '/',
    dropFiles: paths.join(inst, 'drop') + '/',
    security: paths.join(inst, 'security') + '/',
    emailInbound: paths.join(inst, 'mail/email') + '/',
});
_.set(config, 'fileBase.areaStoragePrefix', paths.join(inst, 'file_base') + '/');
_.set(config, 'fileBase.storageTags.general_files', 'general_files');
_.set(config, 'fileBase.areas.general_files', {
    name: 'General Files',
    desc: 'A file area for the harness-terminal walk',
    storageTags: ['general_files'],
});
fs.mkdirSync(paths.join(inst, 'file_base', 'general_files'), { recursive: true });

//  menus, as buildNewConfig() writes them
const includes = [
    'message_base',
    'private_mail',
    'login',
    'new_user',
    'doors',
    'file_base',
    'activitypub',
].map(n => {
    const out = `harness-${n}.hjson`;
    const from = paths.join(root, 'misc/menu_templates', `${n}.in.hjson`);
    if (starterNames.length > 0 && 'login' === n) {
        fs.writeFileSync(
            paths.join(inst, 'menus', out),
            addConnectBranches(fs.readFileSync(from, 'utf8'), starterNames)
        );
    } else {
        fs.copyFileSync(from, paths.join(inst, 'menus', out));
    }
    return out;
});
//  the starters with a theme
const themeStarterNames = starterNames.filter(n => Starters[n].themeId);
if (themeStarterNames.length > 0) {
    const themesDir = paths.join(inst, 'themes');
    fs.mkdirSync(themesDir, { recursive: true });
    const stock = paths.join(themesDir, 'luciano_blocktronics');
    fs.rmSync(stock, { recursive: true, force: true });
    fs.cpSync(paths.join(root, 'art/themes/luciano_blocktronics'), stock, {
        recursive: true,
    });
    config.paths.themes = themesDir + '/';

    themeStarterNames.forEach(name => {
        const starter = Starters[name];
        fs.rmSync(paths.join(themesDir, starter.themeId), {
            recursive: true,
            force: true,
        });
        copyStarterTheme(themesDir, name);
        applyStarterConfig(config, name);
    });
}
if (rip) {
    const artDir = paths.join(inst, 'art');
    fs.rmSync(artDir, { recursive: true, force: true });
    fs.cpSync(paths.join(root, 'art/general'), artDir, { recursive: true });
    copyStarterArt(artDir, 'rip');
    config.paths.art = artDir + '/';
}
//  the starter menu files, in Starters order (as "config new" adds them)
starterNames.forEach(name => {
    const starter = Starters[name];
    const out = `harness-${starter.menuTemplate.replace('.in', '')}`;
    fs.copyFileSync(
        paths.join(root, 'misc/menu_templates', starter.menuTemplate),
        paths.join(inst, 'menus', out)
    );
    includes.push(out);
});
const main = fs
    .readFileSync(paths.join(root, 'misc/menu_templates/main.in.hjson'), 'utf8')
    .replace(/%INCLUDE_FILES%/g, includes.join('\n\t\t'));
fs.writeFileSync(paths.join(inst, 'menus', 'harness-main.hjson'), main);

config.general.menuFile = paths.join(inst, 'menus', 'harness-main.hjson');
config.general.achievementFile = paths.join(root, 'config', 'achievements.hjson');

fs.writeFileSync(
    paths.join(inst, 'config.hjson'),
    hjson.rt.stringify(config, { bracesSameLine: true })
);
const second =
    undefined === secondPort
        ? ''
        : `, second listener 127.0.0.1:${secondPort} -> ${secondFirstMenu}`;
console.log(
    `instance written to ${inst} (telnet 127.0.0.1:${port}${second}${
        starterNames.length > 0
            ? `, ${starterNames.map(n => Starters[n].label).join(' and ')} starter`
            : ''
    })`
);

'use strict';
//  Build a throwaway ENiGMA instance (config + menus + data dirs) under a
//  directory, the way `oputil.js config new` does, without prompts.
//  Usage: node make_instance.js [instanceDir] [telnetPort]
//  Defaults: .work/instance beside this file, port 47991 (127.0.0.1 only).
//  Refuses to write into a non-empty directory it did not create (marker file).
const fs = require('fs');
const paths = require('path');
const hjson = require('hjson');
const _ = require('lodash');

const root = paths.resolve(__dirname, '../..');
const MARKER = '.term_harness_instance';
const [instDir = paths.join(__dirname, '.work', 'instance'), portArg = '47991'] =
    process.argv.slice(2);
const inst = paths.resolve(instDir);
const port = parseInt(portArg, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`bad port: ${portArg}`);
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

const { ConfigIncludeKeys } = require(paths.join(root, 'core/oputil/oputil_config.js'));
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
    fs.copyFileSync(
        paths.join(root, 'misc/menu_templates', `${n}.in.hjson`),
        paths.join(inst, 'menus', out)
    );
    return out;
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
console.log(`instance written to ${inst} (telnet 127.0.0.1:${port})`);

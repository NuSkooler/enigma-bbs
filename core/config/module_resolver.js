/* jslint node: true */
'use strict';

//  deps
const fs = require('graceful-fs');
const paths = require('path');

//
//  Can a menu's "module" actually be loaded?
//
//  Mirrors what core/menu_util.js:79-90 asks of it and what
//  core/module_util.js loadModuleEx() then does with the answer:
//
//    * the value goes through asset.getAssetWithShorthand(spec,
//      'systemModule'), so a bare name is a system module and "@userModule:"
//      names one under Config().paths.mods;
//
//    * a module may live at <path>/<name>.js or, so that it can carry its own
//      package.json and dependencies, at <path>/<name>/<name>.js.
//
//  A resolver rather than a name set, because a module name may be a relative
//  path -- "activitypub/ap_search" and "./activitypub/activity_pub_msg_list"
//  are both in the shipped templates -- and enumerating those as names would
//  mean reimplementing the lookup rather than asking it.
//
//  Kept out of refs.js on purpose: that module answers questions from the
//  configuration alone and touches no filesystem.
//

function makeModuleResolver({ systemPath, userPath } = {}) {
    if (!systemPath) {
        return undefined; //  nothing to resolve against; check nothing
    }

    const exists = candidate => {
        try {
            return fs.statSync(candidate).isFile();
        } catch (e) {
            return false;
        }
    };

    return asset => {
        const base = 'userModule' === asset.type ? userPath : systemPath;
        if (!base) {
            return true; //  no mods directory configured; do not object
        }

        //
        //  Coerced because _.isString() -- the gate in refs.js -- is true for
        //  a boxed String, which path.basename() then refuses outright.
        //
        const name = String(asset.asset);

        const root = paths.resolve(base);
        const direct = paths.resolve(root, `${name}.js`);
        const contained = paths.resolve(root, name, `${paths.basename(name)}.js`);

        //
        //  A name may contain path separators, so *each* candidate has to be
        //  confirmed still under the base. Checking only the first is not
        //  enough: given "..", appending ".js" makes a filename inside the
        //  root while the nested form climbs out of it, so the escape happens
        //  on the candidate that was not being looked at.
        //
        const under = candidate => candidate.startsWith(root + paths.sep);

        return (
            (under(direct) && exists(direct)) ||
            (under(contained) && exists(contained))
        );
    };
}

//  Where core/menu_util.js looks: __dirname there is core/, and mods come from
//  the configured paths.mods.
function defaultModuleResolver(config) {
    return makeModuleResolver({
        systemPath: paths.join(__dirname, '..'),
        userPath: config ? config.paths && config.paths.mods : undefined,
    });
}

module.exports = {
    makeModuleResolver,
    defaultModuleResolver,
};

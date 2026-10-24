/* jslint node: true */
'use strict';

//
//  ENIGMA_UNARC_ARCHIVERS: archivers to read with unarc in place of their own
//  tool, as a comma separated list of archives.archivers keys, e.g. "Atr,Lzx".
//  Each named archiver becomes "@reference:archives.archivers.Unarc", exactly
//  what UPGRADE and the Archivers docs show for config.hjson, so an operator's
//  own Unarc override reaches them too.
//
//  The Docker image sets it, because it ships unarc but neither unlzx nor atr,
//  which Debian does not package (#906). Unset, as it is anywhere else,
//  nothing changes.
//
//  This is applied by the config loader (core/config.js) to the defaults it
//  merges config.hjson over, and nowhere else. core/config_default.js stays
//  free of environment input: the schema is built from it, and so are
//  `oputil.js config new`, the reference checks and misc/config.schema.json,
//  none of which may change with the environment they happen to run in.
//
//  Names must match an archiver key exactly; anything else is ignored. The
//  config loader runs before the logger exists, so nothing is logged here;
//  docker/check_tools.js fails the image build on a name it would ignore.
//
//  An entry for the same archiver in config.hjson replaces the reference, as
//  it would any default -- so it must be a complete archiver entry.
//

const EnvVar = 'ENIGMA_UNARC_ARCHIVERS';
const UnarcReference = '@reference:archives.archivers.Unarc';

//  { routed : [ names ], ignored : [ names ] } for |value| against |archivers|
function parseUnarcArchivers(archivers, value) {
    const result = { routed: [], ignored: [] };
    if ('string' !== typeof value) {
        return result;
    }

    for (const name of value.split(',').map(n => n.trim())) {
        if (!name) {
            continue;
        }
        //  own keys only: "constructor", "toString" and the like are not
        //  archivers, however the map's prototype answers for them
        const isArchiver =
            'Unarc' !== name &&
            Object.hasOwn(archivers, name) &&
            null !== archivers[name] &&
            'object' === typeof archivers[name];
        (isArchiver ? result.routed : result.ignored).push(name);
    }
    return result;
}

//  Point the archivers named in |env| at Unarc. Modifies and returns |config|.
function routeArchiversToUnarc(config, env = process.env) {
    const archivers = config && config.archives && config.archives.archivers;
    if (!archivers) {
        return config;
    }
    for (const name of parseUnarcArchivers(archivers, env[EnvVar]).routed) {
        archivers[name] = UnarcReference;
    }
    return config;
}

module.exports = {
    EnvVar,
    UnarcReference,
    parseUnarcArchivers,
    routeArchiversToUnarc,
};

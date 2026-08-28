/* jslint node: true */
'use strict';

//  ENiGMA½
const ConfigModule = require('./config.js');
//  Look up configModule.get on each call rather than capturing it at load
//  time: it is replaced when the Config bootstrapper runs (and by tests
//  swapping in fixture configs), and a load-time capture freezes whichever
//  getter happened to be installed first.  Same reasoning as message_area.js.
const Config = (...args) => ConfigModule.get(...args);
const Errors = require('./enig_error.js').Errors;
const { WellKnownAreaTags } = require('./message_const.js');
const { isValidAreaTag, localAreaTagFor } = require('./area_import.js');

//
//  message_area.js captures dbs.message at module load, so it must not be
//  pulled in before initializeDatabases() has run.  Requiring it lazily keeps
//  this module safe to load from anywhere, including oputil's early paths.
//
const getMessageAreaByTag = areaTag =>
    require('./message_area.js').getMessageAreaByTag(areaTag);

//  deps
const fs = require('graceful-fs');
const paths = require('path');
const hjson = require('hjson');
const async = require('async');
const _ = require('lodash');

//
//  Automatic message area creation.
//
//  Areas discovered from inbound EchoMail are written to a *generated* hjson
//  file that config.hjson pulls in via `includes`.  That placement is what
//  makes the feature safe to re-run: includes are merged with
//
//      _.defaultsDeep(config, includedConfig)     config_loader.js
//
//  which fills only keys config.hjson does not already have.  config.hjson
//  therefore always wins, so this file can be rewritten wholesale on every
//  pass without ever clobbering something an operator set by hand.
//
//  Consequences of that same merge, all load bearing:
//
//  * config_default.js is merged *before* includes, so a generated value can
//    never override a default.  Nothing here restates a defaulted key.
//  * Arrays merge by index rather than being replaced, and the customizer
//    that fixes array semantics for the defaults<->user merge does not apply
//    to includes.  Nothing here emits an array an operator might partially
//    override -- notably `uplinks`, which stays out entirely.
//  * A referenced-but-missing include fails the *entire* config load, so the
//    board will not start.  Writes are staged to a temp file, parsed back,
//    and only then renamed into place.
//

const GeneratedIncludeFileName = 'auto-areas.hjson';

const GeneratedFileHeader = `//
//  ENiGMA½ automatic message areas
//
//  GENERATED FILE -- do not edit.  It is rewritten whenever automatic area
//  creation runs, and anything you add here will be lost.
//
//  Areas here are created read-only: they carry no "uplinks" (nothing is
//  exported) and an "acs.write" of ID0, which no user satisfies, so nothing
//  can be posted into them either.  Without both, a local post would vanish
//  into an area that looks live but goes nowhere.
//
//  To adopt an area, define it in config.hjson -- that file wins over this
//  one -- adding "uplinks" and your own "acs".  To make it go away entirely,
//  add its FTN tag to the network's autoAreas.ignore list; it is removed
//  from here on the next pass.  Removing an area does not delete its
//  messages: they stay in the database keyed by area tag, invisible, and
//  reappear if the tag is ever created again.
//
`;

//  ACS that no user can satisfy: user IDs start at 1.
const DenyAllAcs = 'ID0';

const DefaultMaxAutoCreate = 500;

const RejectReasons = {
    Ignored: 'in the network ignore list',
    InvalidTag: 'not a usable area tag',
    WellKnown: 'would collide with a built-in system area',
    ExistingArea: 'an area with that tag already exists',
    ExistingFtnArea: 'an FTN area with that tag is already configured',
    OtherNetwork: 'already generated for a different network',
    MaxReached: 'maximum automatically created areas reached',
};

function getFtnNetworks() {
    return _.get(Config(), 'messageNetworks.ftn.networks', {});
}

//
//  Per-network autoAreas config, or null.  Following the design, there is no
//  parent `enabled` flag: the feature is on for a network iff one of its
//  sources is on.  Two flags that must agree is a configuration bug waiting
//  to happen.
//
function getAutoAreasConfig(networkName) {
    const autoAreas = _.get(getFtnNetworks(), [networkName, 'autoAreas']);
    if (!_.isObject(autoAreas)) {
        return null;
    }

    const onDemand = _.get(autoAreas, 'onDemand', {});
    const infoPack = _.get(autoAreas, 'infoPack', {});

    if (true !== onDemand.enabled && true !== infoPack.enabled) {
        return null;
    }

    return Object.assign({}, autoAreas, {
        networkName,
        confTag: autoAreas.confTag,
        ignore: Array.isArray(autoAreas.ignore) ? autoAreas.ignore : [],
        maxAutoCreate: _.isNumber(autoAreas.maxAutoCreate)
            ? autoAreas.maxAutoCreate
            : DefaultMaxAutoCreate,
        onDemand,
        infoPack,
    });
}

//  Networks that want areas created when unknown EchoMail arrives
function onDemandNetworkNames() {
    return Object.keys(getFtnNetworks()).filter(networkName => {
        const cfg = getAutoAreasConfig(networkName);
        return cfg && true === cfg.onDemand.enabled;
    });
}

function anyAutoAreasEnabled() {
    return Object.keys(getFtnNetworks()).some(n => getAutoAreasConfig(n) !== null);
}

function getGeneratedIncludePath() {
    const basePath = ConfigModule.Config.getBasePath();
    if (!basePath) {
        return undefined;
    }
    return paths.join(paths.dirname(basePath), GeneratedIncludeFileName);
}

//
//  The generated file has to exist *and* be listed in config.hjson's
//  `includes` before it does anything, and it must exist before it is
//  referenced or the board will not boot.  `oputil.js mb auto-areas init`
//  does both in the right order; this reports what is actually in place.
//
function getGeneratedIncludeState() {
    const path = getGeneratedIncludePath();
    const state = { path, exists: false, included: false };

    if (!path) {
        return state;
    }

    state.exists = fs.existsSync(path);

    const includes = _.get(Config(), 'includes');
    if (Array.isArray(includes)) {
        state.included = includes.some(
            inc => paths.basename(inc) === GeneratedIncludeFileName
        );
    }

    return state;
}

function emptyGenerated() {
    return {
        messageConferences: {},
        messageNetworks: { ftn: { areas: {} } },
    };
}

function readGenerated(path, cb) {
    fs.readFile(path, 'utf8', (err, data) => {
        if (err) {
            //  A missing file is fine -- nothing has been generated yet.
            if ('ENOENT' === err.code) {
                return cb(null, emptyGenerated());
            }
            return cb(err);
        }

        let parsed;
        try {
            parsed = hjson.parse(data);
        } catch (e) {
            //
            //  Refuse to overwrite something we cannot read.  If the board is
            //  running, this file parsed at boot, so whatever is here now was
            //  changed underneath us and is the operator's to sort out.
            //
            return cb(
                Errors.Invalid(`Cannot parse generated area file "${path}": ${e.message}`)
            );
        }

        return cb(null, _.defaultsDeep(parsed || {}, emptyGenerated()));
    });
}

//  Areas in the generated file belonging to |networkName|
function generatedAreasForNetwork(generated, networkName) {
    return _.pickBy(
        _.get(generated, 'messageNetworks.ftn.areas', {}),
        areaConf => _.get(areaConf, 'network') === networkName
    );
}

//
//  Write the generated file atomically: stage to a temp file in the same
//  directory, parse it back to prove it loads, then rename over the original.
//  A truncated or unparsable include here stops the board from starting.
//
function writeGenerated(path, generated, cb) {
    let body;
    try {
        body =
            GeneratedFileHeader +
            hjson.stringify(generated, {
                emitRootBraces: true,
                bracesSameLine: true,
                space: 4,
                quotes: 'min',
                eol: '\n',
            }) +
            '\n';
    } catch (e) {
        return cb(Errors.UnexpectedState(`Failed generating area config: ${e.message}`));
    }

    //  prove it round-trips before anything can see it
    try {
        hjson.parse(body);
    } catch (e) {
        return cb(
            Errors.UnexpectedState(
                `Generated area config does not parse; refusing to write: ${e.message}`
            )
        );
    }

    const tempPath = `${path}.${process.pid}.tmp`;
    fs.writeFile(tempPath, body, 'utf8', err => {
        if (err) {
            return cb(err);
        }

        fs.rename(tempPath, path, renameErr => {
            if (renameErr) {
                fs.unlink(tempPath, () => {});
                return cb(renameErr);
            }
            return cb(null);
        });
    });
}

//
//  Would creating |ftnTag| for |networkName| collide with something?
//
//  Collisions are refused, never merged.  An FTN tag lower cases straight
//  onto a local area tag, and PRIVATE_MAIL -> private_mail would alias the
//  built-in private mail area -- an echo landing in everyone's mailbox.
//
function checkCollision(ftnTag, areaTag, networkName, generated, config) {
    if (!isValidAreaTag(ftnTag)) {
        return RejectReasons.InvalidTag;
    }

    if (Object.values(WellKnownAreaTags).includes(areaTag)) {
        return RejectReasons.WellKnown;
    }

    const generatedFtnAreas = _.get(generated, 'messageNetworks.ftn.areas', {});
    const alreadyGenerated = generatedFtnAreas[areaTag];
    if (alreadyGenerated) {
        //
        //  Ours already, for this network and tag: re-running is a no-op
        //  rather than a collision.  This matters because import cycles can
        //  overlap -- the 5 minute import watchdog force-completes a cycle
        //  and lets the next one start while the first may still be running.
        //
        if (
            alreadyGenerated.network === networkName &&
            _.toUpper(alreadyGenerated.tag) === _.toUpper(ftnTag)
        ) {
            return null;
        }
        return RejectReasons.OtherNetwork;
    }

    //  Any conference, not just ours: getMessageAreaByTag() stops at the
    //  first conference carrying the tag, so a duplicate elsewhere would
    //  silently win or lose by object key order.
    if (getMessageAreaByTag(areaTag)) {
        return RejectReasons.ExistingArea;
    }

    if (_.has(config, ['messageNetworks', 'ftn', 'areas', areaTag])) {
        return RejectReasons.ExistingFtnArea;
    }

    return null;
}

//
//  Create message areas for |ftnTags| on |networkName|.
//
//  cb(err, {
//      created:  [ { ftnTag, areaTag } ],
//      rejected: [ { ftnTag, areaTag, reason } ],
//      pruned:   [ areaTag ],
//  })
//
//  Creating nothing is a success with an empty |created|.
//
function createAreas(networkName, ftnTags, cb) {
    const autoConfig = getAutoAreasConfig(networkName);
    if (!autoConfig) {
        return cb(
            Errors.MissingConfig(
                `No autoAreas configuration for network "${networkName}"`
            )
        );
    }

    const confTag = autoConfig.confTag;
    if (!_.isString(confTag) || 0 === confTag.length) {
        return cb(
            Errors.MissingConfig(
                `autoAreas for network "${networkName}" has no "confTag"`
            )
        );
    }

    //
    //  The conference must already exist.  defaultsDeep would happily create
    //  one from this file, but it would have areas and no name or desc.
    //  Refuse rather than manufacture a broken conference.
    //
    if (!_.has(Config(), ['messageConferences', confTag])) {
        return cb(
            Errors.MissingConfig(
                `autoAreas confTag "${confTag}" (network "${networkName}") is not a configured message conference`
            )
        );
    }

    const includeState = getGeneratedIncludeState();
    if (!includeState.path) {
        return cb(Errors.UnexpectedState('Configuration base path is unknown'));
    }

    if (!includeState.included) {
        return cb(
            Errors.MissingConfig(
                `"${GeneratedIncludeFileName}" is not listed in the "includes" of ${ConfigModule.Config.getBasePath()}; ` +
                    'run "oputil.js mb auto-areas init"'
            )
        );
    }

    const ignore = new Set(autoConfig.ignore.map(t => _.toUpper(String(t))));

    let result;

    async.waterfall(
        [
            callback => readGenerated(includeState.path, callback),
            (generated, callback) => {
                const config = Config();
                result = { created: [], rejected: [], pruned: [] };

                //
                //  The ignore list is the only way to un-create something, so
                //  it has to apply to what is already here, not just to new
                //  arrivals.
                //
                _.forEach(
                    generatedAreasForNetwork(generated, networkName),
                    (areaConf, areaTag) => {
                        if (ignore.has(_.toUpper(areaConf.tag || ''))) {
                            delete generated.messageNetworks.ftn.areas[areaTag];
                            _.forEach(generated.messageConferences, conf => {
                                if (conf.areas) {
                                    delete conf.areas[areaTag];
                                }
                            });
                            result.pruned.push(areaTag);
                        }
                    }
                );

                //  Deterministic order so a maxAutoCreate cut is reproducible
                const candidates = Array.from(
                    new Set(ftnTags.map(t => String(t).trim()).filter(t => t.length > 0))
                ).sort();

                let count = Object.keys(
                    generatedAreasForNetwork(generated, networkName)
                ).length;

                candidates.forEach(ftnTag => {
                    const areaTag = localAreaTagFor(ftnTag);

                    if (ignore.has(_.toUpper(ftnTag))) {
                        result.rejected.push({
                            ftnTag,
                            areaTag,
                            reason: RejectReasons.Ignored,
                        });
                        return;
                    }

                    const collision = checkCollision(
                        ftnTag,
                        areaTag,
                        networkName,
                        generated,
                        config
                    );
                    if (collision) {
                        result.rejected.push({ ftnTag, areaTag, reason: collision });
                        return;
                    }

                    if (_.has(generated, ['messageNetworks', 'ftn', 'areas', areaTag])) {
                        //  already ours; nothing to do
                        return;
                    }

                    //
                    //  The cap is on the total, not the run: a per-run cap
                    //  compounds, and ten runs of 500 is 5000 areas.  The
                    //  generated file is the durable counter.
                    //
                    if (count >= autoConfig.maxAutoCreate) {
                        result.rejected.push({
                            ftnTag,
                            areaTag,
                            reason: RejectReasons.MaxReached,
                        });
                        return;
                    }

                    _.set(generated, ['messageConferences', confTag, 'areas', areaTag], {
                        //  Placeholder name/desc.  On-demand discovery knows the
                        //  tag and nothing else; an info pack may replace these
                        //  later, and an operator's config.hjson beats both.
                        name: ftnTag,
                        desc: ftnTag,
                        acs: {
                            write: DenyAllAcs,
                        },
                    });

                    _.set(generated, ['messageNetworks', 'ftn', 'areas', areaTag], {
                        network: networkName,
                        tag: ftnTag,
                        //  deliberately no "uplinks": nothing is exported
                    });

                    result.created.push({ ftnTag, areaTag });
                    count += 1;
                });

                return callback(null, generated);
            },
            (generated, callback) => {
                if (0 === result.created.length && 0 === result.pruned.length) {
                    return callback(null, false);
                }
                writeGenerated(includeState.path, generated, err => callback(err, true));
            },
            (didWrite, callback) => {
                if (!didWrite) {
                    return callback(null);
                }

                //
                //  Reload explicitly rather than waiting on ConfigChanged: the
                //  event fires only on a successful reload, so on failure the
                //  stale config stays live and an await never returns.
                //
                if (!_.isFunction(ConfigModule.reload)) {
                    return callback(
                        Errors.UnexpectedState('Configuration reload is unavailable')
                    );
                }

                ConfigModule.reload(err => {
                    if (err) {
                        return callback(err);
                    }

                    //  ...and prove the areas actually resolve now
                    const unresolved = result.created.filter(
                        c => !getMessageAreaByTag(c.areaTag)
                    );
                    if (unresolved.length > 0) {
                        return callback(
                            Errors.UnexpectedState(
                                `Created areas did not resolve after reload: ${unresolved
                                    .map(u => u.areaTag)
                                    .join(', ')}`
                            )
                        );
                    }

                    return callback(null);
                });
            },
        ],
        err => {
            return cb(err, result);
        }
    );
}

module.exports = {
    GeneratedIncludeFileName,
    DenyAllAcs,
    RejectReasons,

    getAutoAreasConfig,
    onDemandNetworkNames,
    anyAutoAreasEnabled,
    getGeneratedIncludePath,
    getGeneratedIncludeState,
    createAreas,

    //  exported for tests and for oputil
    readGenerated,
    writeGenerated,
    emptyGenerated,
    generatedAreasForNetwork,
};

/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule    = require('./menu_module.js').MenuModule;
const Errors        = require('../core/enig_error.js').Errors;
const ANSI          = require('./ansi_term.js');
const Config        = require('./config.js').get;

//  deps
const async         = require('async');
const _             = require('lodash');

exports.moduleInfo = {
    name    : 'Show Art',
    desc    : 'Module for more advanced methods of displaying art',
    author  : 'NuSkooler',
};

exports.getModule = class ShowArtModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.config.method = this.config.method || 'random';
        this.config.optional = _.get(this.config, 'optional', true);
    }

    initSequence() {
        const self = this;

        async.series(
            [
                function before(callback) {
                    return self.beforeArt(callback);
                },
                function showArt(callback) {
                    //
                    //  How we show art depends on our configuration
                    //
                    let handler = {
                        extraArgs       : self.showByExtraArgs,
                        sequence        : self.showBySequence,
                        random          : self.showByRandom,
                        fileBaseArea    : self.showByFileBaseArea,
                    }[self.config.method] || self.showRandomArt;

                    handler = handler.bind(self);

                    return handler(callback);
                }
            ],
            err => {
                if(err && !self.config.optional) {
                    self.client.log.warn('Error during init sequence', { error : err.message } );
                    return self.prevMenu( () => { /* dummy */ } );
                }

                self.finishedLoading();
                return self.autoNextMenu( () => { /* dummy */ } );
            }
        );
    }

    showByExtraArgs(cb) {
        this.getArtKeyValue( (err, artSpec) => {
            if(err) {
                return cb(err);
            }
            const options = {
                pause   : this.shouldPause(),
                desc    : 'extraArgs',
            };
            return this.displaySingleArtWithOptions(artSpec, options, cb);
        });
    }

    showBySequence(cb) {
        return cb(null);
    }

    showByRandom(cb) {
        return cb(null);
    }

    showByFileBaseArea(cb) {
        this.getArtKeyValue( (err, key) => {
            if(err) {
                return cb(err);
            }

            //  further resolve key -> file base area art
            const artSpec = _.get(Config(), [ 'fileBase', 'areas', key, 'art' ]);
            if(!artSpec) {
                return cb(Errors.MissingConfig(`No art defined for file base area "${key}"`));
            }
            const options = {
                pause   : this.shouldPause(),
                desc    : 'fileBaseArea',
            };
            return this.displaySingleArtWithOptions(artSpec, options, cb);
        });
    }

    getArtKeyValue(cb) {
        const key = this.config.key;
        if(!_.isString(key)) {
            return cb(Errors.MissingConfig('Config option "key" is required for method "extraArgs"'));
        }

        const path = key.split('.');
        const artKey = _.get(this.config, [ 'extraArgs' ].concat(path) );
        if(!_.isString(artKey)) {
            return cb(Errors.MissingParam(`Invalid or missing "extraArgs.${key}" value`));
        }

        return cb(null, artKey);
    }

    displaySingleArtWithOptions(artSpec, options, cb) {
        const self = this;
        async.waterfall(
            [
                function art(callback) {
                    //  :TODO: we really need a way to supply an explicit path to look in, e.g. general/area_art/
                    self.displayAsset(
                        artSpec,
                        self.menuConfig.options,
                        (err, artData) => {
                            if(err) {
                                return callback(err);
                            }
                            const mciData = { menu : artData.mciMap };
                            return callback(null, mciData);
                        }
                    );
                },
                function recordCursorPosition(mciData, callback) {
                    if(!options.pause) {
                        return callback(null, mciData, null);   //  cursor position not needed
                    }

                    self.client.once('cursor position report', pos => {
                        const pausePosition = { row : pos[0], col : 1 };
                        return callback(null, mciData, pausePosition);
                    });

                    self.client.term.rawWrite(ANSI.queryPos());
                },
                function afterArtDisplayed(mciData, pausePosition, callback) {
                    self.mciReady(mciData, err => {
                        return callback(err, pausePosition);
                    });
                },
                function displayPauseIfRequested(pausePosition, callback) {
                    if(!options.pause) {
                        return callback(null);
                    }
                    return self.pausePrompt(pausePosition, callback);
                },
            ],
            err => {
                if(err) {
                    self.client.log.warn( { artSpec, error : err.message }, `Failed to display "${options.desc}" art`);
                }
                return cb(err);
            }
        );
    }
};

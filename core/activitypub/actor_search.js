const { MenuModule } = require('../menu_module');
const { Errors } = require('../enig_error');
const Actor = require('../activitypub/actor');

// deps
const async = require('async');
const { get, truncate } = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub Actor Search',
    desc: 'Menu item to search for an ActivityPub actor',
    author: 'CognitiveGears',
};

const FormIds = {
    main: 0,
    view: 1,
};

const MciViewIds = {
    main: {
        searchUrl: 1,
        searchOrCancel: 2,
    },
    view: {
        userName: 1,
        fullName: 2,
    },
};

exports.getModule = class ActivityPubActorSearch extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            submit: (formData, extraArgs, cb) => {
                switch (formData.submitId) {
                    case MciViewIds.main.searchUrl: {
                        return this._search(formData.value, cb);
                    }
                    case MciViewIds.main.searchOrCancel: {
                        const search = get(formData, 'value.searchOrCancel') === 0;
                        return search
                            ? this._search(formData.value, cb)
                            : this.prevMenu(cb);
                    }

                    default:
                        cb(
                            Errors.UnexpectedState(
                                `Unexpected submitId: ${formData.submitId}`
                            )
                        );
                }
            },
        };
    }

    initSequence() {
        async.series(
            [
                callback => {
                    return this.beforeArt(callback);
                },
                callback => {
                    return this._displayMainPage(false, callback);
                },
            ],
            () => {
                this.finishedLoading();
            }
        );
    }

    _search(values, cb) {
        const searchString = values['searchUrl'].trim();
        //TODO: Handle empty searchString
        Actor.fromId(searchString, (err, remoteActor) => {
            if (err) {
                this.client.log.warn(
                    { remoteActor: remoteActor, err: err },
                    'Failure to search for actor'
                );
                // TODO: Add error to page for failure to find actor
                return this._displayMainPage(true, cb);
            }
            return this._displayListScreen(remoteActor, cb);
        });
    }

    _displayListScreen(remoteActor, cb) {
        async.series(
            [
                callback => {
                    return this.displayArtAndPrepViewController(
                        'view',
                        FormIds.view,
                        { clearScreen: true },
                        callback
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'view',
                        Object.values(MciViewIds.view),
                        callback
                    );
                },
                callback => {
                    const v = id => this.getView('view', id);

                    const nameView = v(MciViewIds.view.userName);
                    nameView.setText(
                        truncate(remoteActor.preferredUsername, {
                            length: nameView.getWidth(),
                        })
                    );

                    // TODO: FIXME: fullNameView.getWidth() is 0 - I'm thinking it's getting form 0 for some reason
                    const fullNameView = v(MciViewIds.view.fullName);
                    fullNameView.setText(
                        truncate(remoteActor.name, { length: fullNameView.getWidth() })
                    );
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _displayMainPage(clearScreen, cb) {
        async.series(
            [
                callback => {
                    return this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen },
                        callback
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'main',
                        Object.values(MciViewIds.main),
                        callback
                    );
                },
            ],
            err => {
                return cb(err);
            }
        );
    }
};

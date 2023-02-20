const { MenuModule } = require('../menu_module');
const { Errors } = require('../enig_error');
const Actor = require('../activitypub/actor');
const moment = require('moment');
const { htmlToMessageBody } = require('./util');
const { Collections } = require('./const');
const Collection = require('./collection');
const EnigAssert = require('../enigma_assert');
const { sendFollowRequest, sendUnfollowRequest } = require('./follow_util');
const { getServer } = require('../listening_server');

// deps
const async = require('async');
const { get, isEmpty, isObject, cloneDeep } = require('lodash');

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
        searchQuery: 1,
    },
    view: {
        userName: 1,
        fullName: 2,
        datePublished: 3,
        manualFollowers: 4,
        numberFollowers: 5,
        numberFollowing: 6,
        summary: 7,

        customRangeStart: 10,
    },
};

exports.getModule = class ActivityPubActorSearch extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            search: (formData, extraArgs, cb) => {
                return this._search(formData.value, cb);
            },
            toggleFollowKeyPressed: (formData, extraArgs, cb) => {
                return this._toggleFollowStatus(err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed to toggle follow status'
                        );
                    }
                    return cb(err);
                });
            },
            backKeyPressed: (formData, extraArgs, cb) => {
                return this._displayMainPage(true, cb);
            },
        };
    }

    initSequence() {
        this.webServer = getServer('codes.l33t.enigma.web.server');
        if (!this.webServer) {
            this.client.log('Could not get Web server');
            return this.prevMenu();
        }
        this.webServer = this.webServer.instance;

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
        const searchString = values.searchQuery.trim();
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

            this.selectedActorInfo = remoteActor;
            return this._displayViewPage(cb);
        });
    }

    _displayViewPage(cb) {
        EnigAssert(isObject(this.selectedActorInfo), 'No Actor selected!');

        async.series(
            [
                callback => {
                    if (this.viewControllers.main) {
                        this.viewControllers.main.setFocus(false);
                    }

                    return this.displayArtAndPrepViewController(
                        'view',
                        FormIds.view,
                        { clearScreen: true },
                        (err, artInfo, wasCreated) => {
                            if (!err && !wasCreated) {
                                this.viewControllers.view.setFocus(true);
                            }
                            return callback(err);
                        }
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'view',
                        Object.values(MciViewIds.view).filter(
                            id => id !== MciViewIds.view.customRangeStart
                        ),
                        callback
                    );
                },
                callback => {
                    this._updateCollectionItemCount(Collections.Following, () => {
                        return this._updateCollectionItemCount(
                            Collections.Followers,
                            callback
                        );
                    });
                },
                callback => {
                    const v = id => this.getView('view', id);

                    const nameView = v(MciViewIds.view.userName);
                    nameView.setText(this.selectedActorInfo.preferredUsername);

                    const fullNameView = v(MciViewIds.view.fullName);
                    fullNameView.setText(this.selectedActorInfo.name);

                    const datePublishedView = v(MciViewIds.view.datePublished);
                    if (isEmpty(this.selectedActorInfo.published)) {
                        datePublishedView.setText('Not available.');
                    } else {
                        const publishedDate = moment(this.selectedActorInfo.published);
                        datePublishedView.setText(
                            publishedDate.format(this.getDateFormat())
                        );
                    }

                    const manualFollowersView = v(MciViewIds.view.manualFollowers);
                    manualFollowersView.setText(
                        this.selectedActorInfo.manuallyApprovesFollowers
                    );

                    const followerCountView = v(MciViewIds.view.numberFollowers);
                    followerCountView.setText(
                        this.selectedActorInfo._followersCount > -1
                            ? this.selectedActorInfo._followersCount
                            : '--'
                    );

                    const followingCountView = v(MciViewIds.view.numberFollowing);
                    followingCountView.setText(
                        this.selectedActorInfo._followingCount > -1
                            ? this.selectedActorInfo._followingCount
                            : '--'
                    );

                    const summaryView = v(MciViewIds.view.summary);
                    summaryView.setText(
                        htmlToMessageBody(this.selectedActorInfo.summary)
                    );
                    summaryView.redraw();

                    return this._setFollowStatus(callback);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _setFollowStatus(cb) {
        Collection.ownedObjectByNameAndId(
            Collections.Following,
            this.client.user,
            this.selectedActorInfo.id,
            (err, followingActorEntry) => {
                if (err) {
                    return cb(err);
                }

                this.selectedActorInfo._isFollowing = followingActorEntry ? true : false;
                this.selectedActorInfo._followingIndicator =
                    this._getFollowingIndicator();

                this.updateCustomViewTextsWithFilter(
                    'view',
                    MciViewIds.view.customRangeStart,
                    this._getCustomInfoFormatObject()
                );

                return cb(null);
            }
        );
    }

    _toggleFollowStatus(cb) {
        // catch early key presses
        if (!this.selectedActorInfo) {
            return;
        }

        this.selectedActorInfo._isFollowing = !this.selectedActorInfo._isFollowing;
        this.selectedActorInfo._followingIndicator = this._getFollowingIndicator();

        const finish = e => {
            this.updateCustomViewTextsWithFilter(
                'view',
                MciViewIds.view.customRangeStart,
                this._getCustomInfoFormatObject()
            );

            return cb(e);
        };

        const actor = this._getSelectedActor(); // actor info -> actor
        return this.selectedActorInfo._isFollowing
            ? sendFollowRequest(this.client.user, actor, this.webServer, finish)
            : sendUnfollowRequest(this.client.user, actor, this.webServer, finish);
    }

    _getSelectedActor() {
        const actor = cloneDeep(this.selectedActorInfo);

        //  nuke our added properties
        delete actor._isFollowing;
        delete actor._followingIndicator;
        delete actor._followingCount;
        delete actor._followersCount;

        return actor;
    }

    _getFollowingIndicator() {
        return this.selectedActorInfo._isFollowing
            ? this.config.followingIndicator || 'Following'
            : this.config.notFollowingIndicator || 'Not following';
    }

    _getCustomInfoFormatObject() {
        const formatObj = {
            followingCount: this.selectedActorInfo._followingCount,
            followerCount: this.selectedActorInfo._followersCount,
        };

        const v = f => {
            return this.selectedActorInfo[f] || '';
        };

        Object.assign(formatObj, {
            actorId: v('id'),
            actorSubject: v('subject'),
            actorType: v('type'),
            actorName: v('name'),
            actorSummary: v('summary'),
            actorPreferredUsername: v('preferredUsername'),
            actorUrl: v('url'),
            actorImage: v('image'),
            actorIcon: v('icon'),
            actorFollowing: this.selectedActorInfo._isFollowing,
            actorFollowingIndicator: v('_followingIndicator'),
            text: v('name'),
        });

        return formatObj;
    }

    _displayMainPage(clearScreen, cb) {
        async.series(
            [
                callback => {
                    if (this.viewControllers.view) {
                        this.viewControllers.view.setFocus(false);
                    }
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

    _updateCollectionItemCount(collectionName, cb) {
        const collectionUrl = this.selectedActorInfo[collectionName];
        this._retrieveCountFromCollectionUrl(collectionUrl, (err, count) => {
            if (err) {
                this.client.log.warn(
                    { err: err },
                    `Unable to get Collection count for ${collectionUrl}`
                );
                this.selectedActorInfo[`_${collectionName}Count`] = -1;
            } else {
                this.selectedActorInfo[`_${collectionName}Count`] = count;
            }

            return cb(null);
        });
    }

    _retrieveCountFromCollectionUrl(collectionUrl, cb) {
        collectionUrl = collectionUrl.trim();
        if (isEmpty(collectionUrl)) {
            return cb(Errors.UnexpectedState('Count URL can not be empty.'));
        }

        Collection.getRemoteCollectionStats(collectionUrl, (err, stats) => {
            return cb(err, err ? null : stats.totalItems);
        });
    }
};

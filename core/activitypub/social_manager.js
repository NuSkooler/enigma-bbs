const { MenuModule } = require('../menu_module');
const Collection = require('./collection');
const { getServer } = require('../listening_server');
const Endpoints = require('./endpoint');
const Actor = require('./actor');
const stringFormat = require('../string_format');
const { pipeToAnsi } = require('../color_codes');
const MultiLineEditTextView =
    require('../multi_line_edit_text_view').MultiLineEditTextView;
const {
    sendFollowRequest,
    sendUnfollowRequest,
    acceptFollowRequest,
} = require('./follow_util');
const { Collections } = require('./const');
const EnigAssert = require('../enigma_assert');

// deps
const async = require('async');
const { get, cloneDeep } = require('lodash');
const { htmlToMessageBody } = require('./util');

exports.moduleInfo = {
    name: 'ActivityPub Social Manager',
    desc: 'Manages ActivityPub Actors the current user is following or being followed by.',
    author: 'NuSkooler',
};

const FormIds = {
    main: 0,
};

const MciViewIds = {
    main: {
        actorList: 1,
        selectedActorInfo: 2,
        navMenu: 3,

        customRangeStart: 10,
    },
};

exports.getModule = class activityPubSocialManager extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);

        this.followingActors = [];
        this.followerActors = [];
        this.followRequests = [];
        this.currentCollection = Collections.Following;
        this.currentHelpText = '';

        this.menuMethods = {
            actorListKeyPressed: (formData, extraArgs, cb) => {
                switch (formData.key.name) {
                    case 'space':
                        {
                            if (this.currentCollection === Collections.Following) {
                                return this._toggleFollowing(cb);
                            } else if (
                                this.currentCollection === Collections.FollowRequests
                            ) {
                                return this._acceptFollowRequest(cb);
                            }
                        }
                        break;

                    case 'delete':
                        {
                            if (this.currentCollection === Collections.Followers) {
                                return this._removeFollower(cb);
                            } else if (
                                this.currentCollection === Collections.FollowRequests
                            ) {
                                return this._denyFollowRequest(cb);
                            }
                        }
                        break;
                }
            },
            listKeyPressed: (formData, extraArgs, cb) => {
                const actorListView = this.getView('main', MciViewIds.main.actorList);
                if (actorListView) {
                    const keyName = get(formData, 'key.name');
                    switch (keyName) {
                        case 'down arrow':
                            actorListView.focusNext();
                            break;
                        case 'up arrow':
                            actorListView.focusPrevious();
                            break;
                    }
                }
                return cb(null);
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
                    return this._displayMainPage(callback);
                },
            ],
            () => {
                this.finishedLoading();
            }
        );
    }

    _displayMainPage(cb) {
        async.series(
            [
                callback => {
                    return this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen: true },
                        callback
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'main',
                        Object.values(MciViewIds.main).filter(
                            id => id !== MciViewIds.main.customRangeStart
                        ),
                        callback
                    );
                },
                callback => {
                    return this._populateActorLists(callback);
                },
                callback => {
                    const v = id => this.getView('main', id);

                    const actorListView = v(MciViewIds.main.actorList);
                    const selectedActorInfoView = v(MciViewIds.main.selectedActorInfo);
                    const navMenuView = v(MciViewIds.main.navMenu);

                    // We start with following
                    this._switchTo(Collections.Following);

                    actorListView.on('index update', index => {
                        const selectedActor = this._getSelectedActorItem(index);
                        this._updateSelectedActorInfo(
                            selectedActorInfoView,
                            selectedActor
                        );
                    });

                    navMenuView.on('index update', index => {
                        const collectionName = [
                            Collections.Following,
                            Collections.Followers,
                            Collections.FollowRequests,
                        ][index];
                        this._switchTo(collectionName);
                    });

                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _switchTo(collectionName) {
        this.currentCollection = collectionName;
        const actorListView = this.getView('main', MciViewIds.main.actorList);

        let list;
        switch (collectionName) {
            case Collections.Following:
                list = this.followingActors;
                this.currentHelpText =
                    this.config.helpTextFollowing || 'SPC = Toggle Follower';
                break;
            case Collections.Followers:
                list = this.followerActors;
                this.currentHelpText =
                    this.config.helpTextFollowers || 'DEL = Remove Follower';
                break;
            case Collections.FollowRequests:
                list = this.followRequests;
                this.currentHelpText =
                    this.config.helpTextFollowRequests || 'SPC = Accept\r\nDEL = Deny';
                break;
        }
        EnigAssert(list);

        actorListView.setItems(list);
        actorListView.redraw();

        const selectedActor = this._getSelectedActorItem(
            actorListView.getFocusItemIndex()
        );
        const selectedActorInfoView = this.getView(
            'main',
            MciViewIds.main.selectedActorInfo
        );
        if (selectedActor) {
            this._updateSelectedActorInfo(selectedActorInfoView, selectedActor);
        } else {
            selectedActorInfoView.setText('');
            this.updateCustomViewTextsWithFilter(
                'main',
                MciViewIds.main.customRangeStart,
                this._getCustomInfoFormatObject(null),
                { pipeSupport: true }
            );
        }
    }

    _getSelectedActorItem(index) {
        switch (this.currentCollection) {
            case Collections.Following:
                return this.followingActors[index];
            case Collections.Followers:
                return this.followerActors[index];
            case Collections.FollowRequests:
                return this.followRequests[index];
        }
    }

    _getCurrentActorList() {
        return this.currentCollection === Collections.Following
            ? this.followingActors
            : this.followerActors;
    }

    _updateSelectedActorInfo(view, actorInfo) {
        if (actorInfo) {
            const selectedActorInfoFormat =
                this.config.selectedActorInfoFormat || '{text}';

            const s = stringFormat(selectedActorInfoFormat, actorInfo);

            if (view instanceof MultiLineEditTextView) {
                const opts = {
                    prepped: false,
                    forceLineTerm: true,
                };
                view.setAnsi(pipeToAnsi(s, this.client), opts);
            } else {
                view.setText(s);
            }
        }

        this.updateCustomViewTextsWithFilter(
            'main',
            MciViewIds.main.customRangeStart,
            this._getCustomInfoFormatObject(actorInfo),
            { pipeSupport: true }
        );
    }

    _toggleFollowing(cb) {
        const actorListView = this.getView('main', MciViewIds.main.actorList);
        const selectedActor = this._getSelectedActorItem(
            actorListView.getFocusItemIndex()
        );
        if (selectedActor) {
            selectedActor.status = !selectedActor.status;
            selectedActor.statusIndicator = this._getStatusIndicator(
                selectedActor.status
            );

            async.series(
                [
                    callback => {
                        if (Collections.Following === this.currentCollection) {
                            return this._followingActorToggled(selectedActor, callback);
                        } else {
                            return this._followerActorToggled(selectedActor, callback);
                        }
                    },
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message, type: this.currentCollection },
                            `Failed to toggle "${this.currentCollection}" status`
                        );
                    }

                    //  :TODO: we really need updateItem() call on MenuView
                    actorListView.setItems(this._getCurrentActorList());
                    actorListView.redraw(); //  oof

                    return cb(null);
                }
            );
        }
    }

    _acceptFollowRequest(cb) {
        EnigAssert(Collections.FollowRequests === this.currentCollection);

        const actorListView = this.getView('main', MciViewIds.main.actorList);
        const selectedActor = this._getSelectedActorItem(
            actorListView.getFocusItemIndex()
        );

        if (!selectedActor) {
            return cb(null);
        }

        const request = selectedActor.request;
        EnigAssert(request);

        acceptFollowRequest(this.client.user, selectedActor, request, err => {
            if (err) {
                this.client.log.error(
                    { error: err.message },
                    'Failed to fully accept Follow request'
                );
            }

            const followingActor = this.followRequests.splice(
                actorListView.getFocusItemIndex(),
                1
            )[0];
            this.followerActors.push(followingActor); // move to followers

            this._switchTo(this.currentCollection); // redraw

            return cb(err);
        });
    }

    _removeFollower(cb) {
        return cb(null);
    }

    _denyFollowRequest(cb) {
        return cb(null);
    }

    _followingActorToggled(actorInfo, cb) {
        // Local user/Actor wants to follow or un-follow
        const wantsToFollow = actorInfo.status;
        const actor = this._actorInfoToActor(actorInfo);

        return wantsToFollow
            ? sendFollowRequest(this.client.user, actor, cb)
            : sendUnfollowRequest(this.client.user, actor, cb);
    }

    _actorInfoToActor(actorInfo) {
        const actor = cloneDeep(actorInfo);

        //  nuke our added properties
        delete actor.subject;
        delete actor.text;
        delete actor.status;
        delete actor.statusIndicator;
        delete actor.plainTextSummary;

        return actor;
    }

    _followerActorToggled(actorInfo, cb) {
        return cb(null);
    }

    _getCustomInfoFormatObject(actorInfo) {
        const formatObj = {
            followingCount: this.followingActors.length,
            followerCount: this.followerActors.length,
        };

        const v = f => {
            return actorInfo ? actorInfo[f] || '' : '';
        };

        Object.assign(formatObj, {
            selectedActorId: v('id'),
            selectedActorSubject: v('subject'),
            selectedActorType: v('type'),
            selectedActorName: v('name'),
            selectedActorSummary: v('summary'),
            selectedActorPlainTextSummary: actorInfo
                ? htmlToMessageBody(actorInfo.summary || '')
                : '',
            selectedActorPreferredUsername: v('preferredUsername'),
            selectedActorUrl: v('url'),
            selectedActorImage: v('image'),
            selectedActorIcon: v('icon'),
            selectedActorStatus: actorInfo ? actorInfo.status : false,
            selectedActorStatusIndicator: v('statusIndicator'),
            text: v('name'),
            helpText: this.currentHelpText,
        });

        return formatObj;
    }

    _getStatusIndicator(enabled) {
        return enabled
            ? this.config.statusFollowing || '√'
            : this.config.statusNotFollowing || 'X';
    }

    _populateActorLists(cb) {
        async.waterfall(
            [
                callback => {
                    return this._fetchActorList(Collections.Following, callback);
                },
                (following, callback) => {
                    this._fetchActorList(Collections.Followers, (err, followers) => {
                        return callback(err, following, followers);
                    });
                },
                (following, followers, callback) => {
                    this._fetchFollowRequestActors((err, followRequests) => {
                        return callback(err, following, followers, followRequests);
                    });
                },
                (following, followers, followRequests, callback) => {
                    const mapper = a => {
                        a.plainTextSummary = htmlToMessageBody(a.summary);
                        return a;
                    };

                    this.followingActors = following.map(mapper);
                    this.followerActors = followers.map(mapper);
                    this.followRequests = followRequests.map(mapper);

                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    _fetchFollowRequestActors(cb) {
        Collection.followRequests(this.client.user, 'all', (err, collection) => {
            if (err) {
                return cb(err);
            }

            if (!collection.orderedItems || collection.orderedItems.length < 1) {
                return cb(null, []);
            }

            const statusIndicator = this._getStatusIndicator(false);

            async.mapLimit(
                collection.orderedItems,
                4,
                (request, nextRequest) => {
                    const actorId = request.actor;
                    Actor.fromId(actorId, (err, actor, subject) => {
                        if (err) {
                            this.client.log.warn({ actorId }, 'Failed to retrieve Actor');
                            return nextRequest(null, null);
                        }

                        //  Add some of our own properties
                        Object.assign(actor, {
                            subject,
                            status: false,
                            statusIndicator,
                            text: actor.preferredUsername,
                            request,
                        });

                        return nextRequest(null, actor);
                    });
                },
                (err, actorsList) => {
                    if (err) {
                        return cb(err);
                    }

                    actorsList = actorsList.filter(f => f); //   drop nulls
                    return cb(null, actorsList);
                }
            );
        });
    }

    _fetchActorList(collectionName, cb) {
        const collectionId = Endpoints[collectionName](this.client.user);
        Collection[collectionName](collectionId, 'all', (err, collection) => {
            if (err) {
                return cb(err);
            }

            if (!collection.orderedItems || collection.orderedItems.length < 1) {
                return cb(null, []);
            }

            const statusIndicator = this._getStatusIndicator(true);

            async.mapLimit(
                collection.orderedItems,
                4,
                (actorId, nextActorId) => {
                    Actor.fromId(actorId, (err, actor, subject) => {
                        if (err) {
                            this.client.log.warn({ actorId }, 'Failed to retrieve Actor');
                            return nextActorId(null, null);
                        }

                        //  Add some of our own properties
                        Object.assign(actor, {
                            subject,
                            status: true,
                            statusIndicator,
                            text: actor.name,
                        });

                        return nextActorId(null, actor);
                    });
                },
                (err, actorsList) => {
                    if (err) {
                        return cb(err);
                    }

                    actorsList = actorsList.filter(f => f); //   drop nulls
                    return cb(null, actorsList);
                }
            );
        });
    }
};

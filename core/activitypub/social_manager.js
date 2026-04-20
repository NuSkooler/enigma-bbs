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
    rejectFollowRequest,
} = require('./follow_util');
const { Collections } = require('./const');
const EnigAssert = require('../enigma_assert');
const { wordWrapText } = require('../word_wrap');

// deps
const async = require('async');
const { get } = require('lodash');
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
                const collection = this.currentCollection;
                switch (formData.key.name) {
                    case 'space':
                        {
                            if (collection === Collections.Following) {
                                return this._toggleFollowing(cb);
                            }
                            if (collection === Collections.FollowRequests) {
                                return this._acceptFollowRequest(cb);
                            }
                        }
                        break;

                    case 'delete':
                        {
                            if (collection === Collections.Followers) {
                                return this._removeFollower(cb);
                            }

                            if (collection === Collections.FollowRequests) {
                                return this._rejectFollowRequest(cb);
                            }
                        }
                        break;
                }

                return cb(null);
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
            composeToSelected: (formData, extraArgs, cb) => {
                return this._composeToSelected(cb);
            },
            searchActors: (formData, extraArgs, cb) => {
                return this._searchActors(cb);
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

            let s = stringFormat(selectedActorInfoFormat, actorInfo);

            if (view instanceof MultiLineEditTextView) {
                // word wrap individual lines to prevent losing the original LFs
                let lines = s.split('\n');
                let wrapped = '';
                for (let line of lines) {
                    wrapped +=
                        (
                            wordWrapText(line, {
                                width: view.dimens.width,
                                pipeCodeSupport: true,
                            }).wrapped || []
                        ).join('\n') + '\n';
                }

                const opts = {
                    prepped: false,
                    forceLineTerm: true,
                };
                view.setAnsi(pipeToAnsi(wrapped, this.client), opts);
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
                        return this._followingActorToggled(selectedActor, callback);
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

                    const selectedActorInfoView = this.getView(
                        'main',
                        MciViewIds.main.selectedActorInfo
                    );
                    this._updateSelectedActorInfo(
                        selectedActorInfoView,
                        this._getSelectedActorItem(actorListView.getFocusItemIndex())
                    );

                    return cb(null);
                }
            );
        }
    }

    _removeSelectedFollowRequest(actorListView, moveToFollowers) {
        const followingActor = this.followRequests.splice(
            actorListView.getFocusItemIndex(),
            1
        )[0];

        if (moveToFollowers) {
            this.followerActors.push(followingActor);
        }

        this._switchTo(this.currentCollection); // redraw
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
                    'Error Accepting Follow request'
                );
            }

            this._removeSelectedFollowRequest(actorListView, true); // true=move to followers

            return cb(err);
        });
    }

    _removeFollower(cb) {
        const actorListView = this.getView('main', MciViewIds.main.actorList);
        const idx = actorListView.getFocusItemIndex();
        const selectedActor = this._getSelectedActorItem(idx);
        if (!selectedActor) {
            return cb(null);
        }

        Collection.removeOwnedById(
            Collections.Followers,
            this.client.user,
            selectedActor.id,
            err => {
                if (err) {
                    this.client.log.error(
                        { error: err.message },
                        'Error removing follower'
                    );
                    return cb(err);
                }

                this.followerActors.splice(idx, 1);
                this._switchTo(this.currentCollection); // redraw
                return cb(null);
            }
        );
    }

    _rejectFollowRequest(cb) {
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

        rejectFollowRequest(this.client.user, selectedActor, request, err => {
            if (err) {
                this.client.log.error(
                    { error: err.message },
                    'Error Rejecting Follow request'
                );
            }

            this._removeSelectedFollowRequest(actorListView, false); // false=do not move to followers

            return cb(err);
        });
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
        const actor = structuredClone(actorInfo);

        //  nuke our added properties
        delete actor.subject;
        delete actor.text;
        delete actor.status;
        delete actor.statusIndicator;
        delete actor.plainTextSummary;

        return actor;
    }

    _composeToSelected(cb) {
        const actorListView = this.getView('main', MciViewIds.main.actorList);
        const selectedActor = this._getSelectedActorItem(
            actorListView.getFocusItemIndex()
        );
        return this.gotoMenu(
            this.menuConfig.config.menuCompose || 'activityPubCompose',
            selectedActor ? { extraArgs: { toActor: selectedActor.subject } } : {},
            cb
        );
    }

    _searchActors(cb) {
        return this.gotoMenu(
            this.menuConfig.config.menuSearch || 'activityPubActorSearch',
            {},
            cb
        );
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

            const requests = collection.orderedItems;
            if (!requests || requests.length < 1) {
                return cb(null, []);
            }

            const statusIndicator = this._getStatusIndicator(false);
            const ids = requests.map(r => r.actor);

            //  Batch fetch from local actor cache; network-fetch misses
            Collection.actorsFromIds(ids, (err, cached) => {
                if (err) {
                    return cb(err);
                }

                const actorsList = [];
                const missRequests = [];

                for (const request of requests) {
                    const hit = cached.get(request.actor);
                    if (hit) {
                        Object.assign(hit.actor, {
                            subject: hit.subject,
                            status: false,
                            statusIndicator,
                            text: hit.actor.preferredUsername,
                            request,
                        });
                        actorsList.push(hit.actor);
                    } else {
                        missRequests.push(request);
                    }
                }

                if (missRequests.length === 0) {
                    return cb(null, actorsList);
                }

                async.eachLimit(
                    missRequests,
                    4,
                    (request, next) => {
                        const actorId = request.actor;
                        Actor.fromId(actorId, (err, actor, subject) => {
                            if (err) {
                                this.client.log.warn(
                                    { actorId },
                                    'Failed to retrieve Actor'
                                );
                                return next(null); // non-fatal; skip
                            }

                            Object.assign(actor, {
                                subject,
                                status: false,
                                statusIndicator,
                                text: actor.preferredUsername,
                                request,
                            });
                            actorsList.push(actor);
                            return next(null);
                        });
                    },
                    err => {
                        return cb(err || null, actorsList);
                    }
                );
            });
        });
    }

    _fetchActorList(collectionName, cb) {
        const collectionId = Endpoints[collectionName](this.client.user);
        Collection[collectionName](collectionId, 'all', (err, collection) => {
            if (err) {
                return cb(err);
            }

            const ids = collection.orderedItems;
            if (!ids || ids.length < 1) {
                return cb(null, []);
            }

            const statusIndicator = this._getStatusIndicator(true);

            //  Batch fetch from local actor cache first; only network-fetch cache misses
            Collection.actorsFromIds(ids, (err, cached) => {
                if (err) {
                    return cb(err);
                }

                const misses = ids.filter(id => !cached.has(id));

                const finalize = (actor, subject) => {
                    Object.assign(actor, {
                        subject,
                        status: true,
                        statusIndicator,
                        text: actor.name,
                    });
                    return actor;
                };

                //  Build list from cache hits (preserves original order)
                const actorsList = [];
                for (const id of ids) {
                    const hit = cached.get(id);
                    if (hit) {
                        actorsList.push(finalize(hit.actor, hit.subject));
                    }
                }

                if (misses.length === 0) {
                    return cb(null, actorsList);
                }

                //  Fetch cache misses from the network (limit concurrency)
                async.eachLimit(
                    misses,
                    4,
                    (actorId, next) => {
                        Actor.fromId(actorId, (err, actor, subject) => {
                            if (err) {
                                this.client.log.warn(
                                    { actorId },
                                    'Failed to retrieve Actor'
                                );
                                return next(null); // non-fatal; skip entry
                            }

                            actorsList.push(finalize(actor, subject));
                            return next(null);
                        });
                    },
                    err => {
                        return cb(err || null, actorsList);
                    }
                );
            });
        });
    }
};

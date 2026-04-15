'use strict';

//
//  ap_search.js — ActivityPub Search
//
//  Tabbed FTS5-backed search for actors (People), notes (Posts), and hashtags.
//  Replaces the old actor_search.js (URL-only lookup) with a full search UX.
//
//  Forms:
//    0 — Main search: HM1 (tab), ET2 (input), LV3 (results), TL10+ (custom)
//    1 — Actor view:  MT1 (bio/summary), TL10+ (all actor fields)
//
//  On the People tab, full @user@host or https:// input bypasses FTS5 and goes
//  directly to Actor.fromId (remote fetch + cache), matching current behaviour.
//

const { MenuModule } = require('../menu_module');
const { Errors } = require('../enig_error');
const Actor = require('./actor');
const Collection = require('./collection');
const { Collections } = require('./const');
const { htmlToMessageBody } = require('./util');
const { sendFollowRequest, sendUnfollowRequest } = require('./follow_util');
const { getServer } = require('../listening_server');
const UserProps = require('../user_property');
const moment = require('moment');

// deps
const async = require('async');
const { get, isEmpty } = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub Search',
    desc: 'Tabbed FTS5-backed search for AP actors and content',
    author: 'NuSkooler',
};

// ─── constants ────────────────────────────────────────────────────────────────

const FormIds = {
    main:      0,
    actorView: 1,
};

const MciViewIds = {
    main: {
        tabSelect:       1,  // HM1 — People | Posts | Hashtags
        searchInput:     2,  // ET2 — search text input
        results:         3,  // LV3 — result list
        customRangeStart: 10,
    },
    actorView: {
        summary:          1,  // MT1 — bio / summary (HTML-stripped)
        customRangeStart: 10, // TL10+ — all actor fields
    },
};

const Tabs = { People: 0, Posts: 1, Hashtags: 2 };

const TabLabels = ['People', 'Posts', 'Hashtags'];

//  Regex to detect a direct actor URL or @user@host handle — bypasses FTS5.
const AP_HANDLE_RE = /^@\S+@\S+$/;
const AP_URL_RE    = /^https?:\/\//i;

// ─── helpers ──────────────────────────────────────────────────────────────────

//  Pad / truncate s to exactly n chars.
function padR(s, n) {
    s = String(s == null ? '' : s);
    return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

//  Wrap a user-supplied search term as an FTS5 phrase (double-quoted).
//  Internal double-quotes are stripped so FTS5 doesn't choke.
function ftsPhrase(term) {
    return '"' + term.replace(/"/g, '') + '"';
}

//  True when input looks like a direct actor identifier rather than a search term.
function looksLikeActorId(term) {
    return AP_HANDLE_RE.test(term) || AP_URL_RE.test(term);
}

//  Extract a short display handle from an AP actor URL.
//  https://mastodon.social/users/alice  →  @alice@mastodon.social
function actorUrlToHandle(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const user = parts[parts.length - 1] || '?';
        return `@${user}@${u.hostname}`;
    } catch {
        return url;
    }
}

//  Build the default People result line (78 chars).
//    handle(40) + ' ' + displayName(37)
function formatPeopleLine(item) {
    return padR(item.handle, 40) + ' ' + padR(item.displayName, 37);
}

//  Build the default Posts / Hashtag-note result line (79 chars).
//    from(22) + ' ' + subject(36) + ' ' + date(11) + ' ' + att(1)
function formatPostLine(item) {
    return (
        padR(item.from, 22) +
        ' ' +
        padR(item.subject, 36) +
        ' ' +
        padR(item.date, 11) +
        ' ' +
        (item.hasAttachment ? '*' : ' ')
    );
}

//  Build the default Hashtag-actor result line (79 chars).
//    'P' + ' ' + handle(40) + ' ' + displayName(36)
function formatHashtagActorLine(item) {
    return 'P ' + padR(item.handle, 40) + ' ' + padR(item.displayName, 35);
}

//  Build the default Hashtag-note result line (79 chars).
//    'N' + ' ' + from(22) + ' ' + subject(34) + ' ' + date(11) + ' ' + att(1)
function formatHashtagNoteLine(item) {
    return (
        'N ' +
        padR(item.from, 22) +
        ' ' +
        padR(item.subject, 33) +
        ' ' +
        padR(item.date, 11) +
        ' ' +
        (item.hasAttachment ? '*' : ' ')
    );
}

//  Convert a sharedInbox Note into a viewer-compatible item object.
function noteToItem(note, timestamp) {
    const ts = timestamp || note.published || '';
    const dateStr = ts ? moment(ts).format('MM/DD hh:mma') : '';
    return {
        from:          actorUrlToHandle(note.attributedTo),
        subject:       note.name || note.summary || note.content || '',
        date:          dateStr,
        hasAttachment: Array.isArray(note.attachment) && note.attachment.length > 0,
        noteId:        note.id,
        contextId:     note.context || note.conversation || null,
        inReplyTo:     note.inReplyTo || null,
    };
}

// ─── module ───────────────────────────────────────────────────────────────────

exports.getModule = class ApSearchModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        //  Tab state
        this._currentTab    = Tabs.People;
        this._results       = [];   // parallel array of raw objects for Enter dispatch
        this._selectedActor = null; // actor info for Form 1

        this.menuMethods = {
            tabChanged: (formData, _extraArgs, cb) => {
                this._currentTab = formData.value.tab || Tabs.People;
                this._clearResults();
                return cb(null);
            },
            search: (formData, _extraArgs, cb) => {
                const term = (formData.value.searchQuery || '').trim();
                if (!term) return cb(null);
                return this._runSearch(term, cb);
            },
            openResult: (formData, _extraArgs, cb) => {
                return this._openSelected(formData.value.result, cb);
            },
            backKeyPressed: (_formData, _extraArgs, cb) => {
                return this._displayMainPage(true, cb);
            },
            toggleFollowKeyPressed: (_formData, _extraArgs, cb) => {
                return this._toggleFollowStatus(err => {
                    if (err) {
                        this.client.log.error({ err }, 'AP search: toggle follow failed');
                    }
                    return cb(err);
                });
            },
        };
    }

    initSequence() {
        this.webServer = getServer('codes.l33t.enigma.web.server');
        if (!this.webServer) {
            this.client.log.warn('AP search: could not get web server');
            return this.prevMenu();
        }
        this.webServer = this.webServer.instance;

        async.series(
            [
                cb => this.beforeArt(cb),
                cb => this._displayMainPage(false, cb),
            ],
            () => this.finishedLoading()
        );
    }

    // ─── main page (Form 0) ───────────────────────────────────────────────────

    _displayMainPage(clearScreen, cb) {
        async.series(
            [
                callback => {
                    if (this.viewControllers.actorView) {
                        this.viewControllers.actorView.setFocus(false);
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
                        [
                            MciViewIds.main.tabSelect,
                            MciViewIds.main.searchInput,
                            MciViewIds.main.results,
                        ],
                        callback
                    );
                },
                callback => {
                    this._updateMainCustomViews();
                    return callback(null);
                },
            ],
            err => cb(err)
        );
    }

    _updateMainCustomViews() {
        this.updateCustomViewTextsWithFilter(
            'main',
            MciViewIds.main.customRangeStart,
            {
                tabLabel:     TabLabels[this._currentTab] || '',
                resultCount:  String(this._results.length),
            }
        );
    }

    // ─── search dispatch ──────────────────────────────────────────────────────

    _runSearch(term, cb) {
        switch (this._currentTab) {
            case Tabs.People:
                return this._searchPeople(term, cb);
            case Tabs.Posts:
                return this._searchPosts(term, cb);
            case Tabs.Hashtags:
                return this._searchHashtags(term, cb);
            default:
                return cb(null);
        }
    }

    //  People tab —
    //    Direct actor ID / @handle → Actor.fromId (remote fetch + cache)
    //    Free text              → FTS5 local actor cache
    _searchPeople(term, cb) {
        if (looksLikeActorId(term)) {
            return Actor.fromId(term, (err, actor) => {
                if (err) {
                    this.client.log.warn({ term, err }, 'AP search: Actor.fromId failed');
                    this._clearResults();
                    return cb(null);
                }
                //  Direct-lookup result: open actor view immediately.
                this._selectedActor = actor;
                return this._displayActorView(cb);
            });
        }

        Collection.searchActors(ftsPhrase(term), (err, results) => {
            if (err) {
                this.client.log.warn({ term, err }, 'AP search: searchActors failed');
                results = [];
            }

            const items = results.map(({ actor, subject }) => {
                const handle = subject || actorUrlToHandle(actor.id);
                const displayName = actor.name || actor.preferredUsername || '';
                const item = {
                    type:        'actor',
                    handle,
                    displayName,
                    actorId:     actor.id,
                    _actor:      actor,
                };
                item.text = formatPeopleLine(item);
                return item;
            });

            return this._populateResultsList(items, cb);
        });
    }

    //  Posts tab — FTS5 sharedInbox full-text search
    _searchPosts(term, cb) {
        Collection.searchNotes(ftsPhrase(term), (err, notes) => {
            if (err) {
                this.client.log.warn({ term, err }, 'AP search: searchNotes failed');
                notes = [];
            }

            const items = notes.map(note => {
                const item = Object.assign({ type: 'note' }, noteToItem(note));
                item.text = formatPostLine(item);
                return item;
            });

            return this._populateResultsList(items, cb);
        });
    }

    //  Hashtags tab — FTS5 tags column: actors (by subject) + notes (by hashtag)
    _searchHashtags(term, cb) {
        //  Normalise: strip leading # for the FTS5 query.
        const rawTag = term.replace(/^#/, '');
        const ftsTag = 'tags:' + ftsPhrase(rawTag);

        async.parallel(
            {
                actors: innerCb => Collection.searchActors(ftsTag, innerCb),
                notes:  innerCb => Collection.searchNotes(ftsTag, innerCb),
            },
            (err, res) => {
                if (err) {
                    this.client.log.warn({ term, err }, 'AP search: hashtag search failed');
                    res = { actors: [], notes: [] };
                }

                const actorItems = (res.actors || []).map(({ actor, subject }) => {
                    const handle = subject || actorUrlToHandle(actor.id);
                    const item = {
                        type:        'actor',
                        handle,
                        displayName: actor.name || actor.preferredUsername || '',
                        actorId:     actor.id,
                        _actor:      actor,
                    };
                    item.text = formatHashtagActorLine(item);
                    return item;
                });

                const noteItems = (res.notes || []).map(note => {
                    const item = Object.assign({ type: 'note' }, noteToItem(note));
                    item.text = formatHashtagNoteLine(item);
                    return item;
                });

                return this._populateResultsList([...actorItems, ...noteItems], cb);
            }
        );
    }

    // ─── results list ─────────────────────────────────────────────────────────

    _populateResultsList(items, cb) {
        this._results = items;

        const lv = this.getView('main', MciViewIds.main.results);
        if (!lv) return cb(null);

        lv.setItems(items);
        lv.redraw();
        this._updateMainCustomViews();

        return cb(null);
    }

    _clearResults() {
        this._results = [];
        const lv = this.getView('main', MciViewIds.main.results);
        if (lv) {
            lv.setItems([]);
            lv.redraw();
        }
        this._updateMainCustomViews();
    }

    // ─── open selected result ─────────────────────────────────────────────────

    _openSelected(index, cb) {
        const item = this._results[index];
        if (!item) return cb(null);

        if (item.type === 'actor') {
            this._selectedActor = item._actor;
            return this._displayActorView(cb);
        }

        //  Note → push to viewer
        return this.gotoMenu(
            this.config.viewerMenu || 'activityPubMsgViewer',
            {
                extraArgs: {
                    item,
                    itemIndex: index,
                    items:     this._results.filter(r => r.type === 'note'),
                    modeLabel: 'Search',
                },
            },
            cb
        );
    }

    // ─── actor view (Form 1) ──────────────────────────────────────────────────

    _displayActorView(cb) {
        async.series(
            [
                callback => {
                    if (this.viewControllers.main) {
                        this.viewControllers.main.setFocus(false);
                    }
                    return this.displayArtAndPrepViewController(
                        'actorView',
                        FormIds.actorView,
                        { clearScreen: true },
                        (err, _artInfo, wasCreated) => {
                            if (!err && !wasCreated) {
                                this.viewControllers.actorView.setFocus(true);
                            }
                            return callback(err);
                        }
                    );
                },
                callback => {
                    return this.validateMCIByViewIds(
                        'actorView',
                        [MciViewIds.actorView.summary],
                        callback
                    );
                },
                callback => {
                    return this._setFollowStatus(callback);
                },
                callback => {
                    return this._fetchActorCounts(callback);
                },
                callback => {
                    return this._updateActorView(callback);
                },
            ],
            err => cb(err)
        );
    }

    _updateActorView(cb) {
        const summaryView = this.getView('actorView', MciViewIds.actorView.summary);
        if (summaryView) {
            const bioText = htmlToMessageBody(this._selectedActor.summary || '');
            summaryView.setText(bioText);
            summaryView.redraw();
        }

        this.updateCustomViewTextsWithFilter(
            'actorView',
            MciViewIds.actorView.customRangeStart,
            this._actorFormatObject()
        );

        return cb(null);
    }

    //  Build the format object for TL10+ in the actor view.
    //  All actor fields are available; operators choose what to display via art.
    _actorFormatObject() {
        const a = this._selectedActor || {};
        const v = f => a[f] || '';

        return {
            //  Display fields
            handle:                   a._subject || actorUrlToHandle(a.id),
            preferredUsername:         v('preferredUsername'),
            displayName:              v('name'),
            published:                isEmpty(a.published)
                ? ''
                : moment(a.published).format(this.getDateFormat()),
            followersCount:           a._followersCount >= 0 ? a._followersCount : '--',
            followingCount:           a._followingCount >= 0 ? a._followingCount : '--',
            followIndicator:          this._followIndicator(),
            manuallyApprovesFollowers: a.manuallyApprovesFollowers ? 'Yes' : 'No',

            //  Raw fields for advanced theme formatting
            actorId:      v('id'),
            actorUrl:     v('url'),
            actorType:    v('type'),
            actorSummary: v('summary'),
            actorImage:   v('image'),
            actorIcon:    v('icon'),
            actorFollowing: !!a._isFollowing,

            //  Legacy compat for themes built against actor_search.js
            text:              v('name'),
            actorName:         v('name'),
            actorPreferredUsername: v('preferredUsername'),
            actorSubject:      a._subject || actorUrlToHandle(a.id),
            actorFollowingIndicator: this._followIndicator(),
            followingCount:    a._followingCount >= 0 ? a._followingCount : '--',
            followerCount:     a._followersCount >= 0 ? a._followersCount : '--',
        };
    }

    // ─── follow state ─────────────────────────────────────────────────────────

    _followIndicator() {
        return this._selectedActor && this._selectedActor._isFollowing
            ? this.config.followingIndicator    || 'Following'
            : this.config.notFollowingIndicator || 'Not following';
    }

    _setFollowStatus(cb) {
        if (!this._selectedActor) return cb(null);

        Collection.ownedObjectByNameAndId(
            Collections.Following,
            this.client.user,
            this._selectedActor.id,
            (err, entry) => {
                if (!err) {
                    this._selectedActor._isFollowing = !!entry;
                }
                return cb(null); // non-fatal
            }
        );
    }

    _toggleFollowStatus(cb) {
        if (!this._selectedActor) {
            return cb(Errors.UnexpectedState('No actor selected'));
        }

        const currentActorId = this.client.user.getProperty(UserProps.ActivityPubActorId);
        if (currentActorId === this._selectedActor.id) {
            return cb(Errors.Invalid('You cannot follow yourself!'));
        }

        this._selectedActor._isFollowing = !this._selectedActor._isFollowing;

        const actor = this._cleanActor();
        const done = e => {
            this.updateCustomViewTextsWithFilter(
                'actorView',
                MciViewIds.actorView.customRangeStart,
                this._actorFormatObject()
            );
            return cb(e);
        };

        return this._selectedActor._isFollowing
            ? sendFollowRequest(this.client.user, actor, done)
            : sendUnfollowRequest(this.client.user, actor, done);
    }

    //  Return a clean actor object without our internal _ properties.
    _cleanActor() {
        const actor = structuredClone(this._selectedActor);
        delete actor._isFollowing;
        delete actor._followersCount;
        delete actor._followingCount;
        delete actor._subject;
        return actor;
    }

    // ─── follower / following counts ──────────────────────────────────────────

    //  Fetch follower and following counts from the actor's collection URLs.
    //  Non-fatal: sets count to -1 on error so the view shows '--'.
    _fetchActorCounts(cb) {
        const actor = this._selectedActor;
        if (!actor) return cb(null);

        async.parallel(
            [
                innerCb => this._fetchCount(actor.followers, '_followersCount', innerCb),
                innerCb => this._fetchCount(actor.following, '_followingCount', innerCb),
            ],
            () => cb(null) // always non-fatal
        );
    }

    _fetchCount(url, prop, cb) {
        if (!url || typeof url !== 'string' || !url.trim()) {
            this._selectedActor[prop] = -1;
            return cb(null);
        }
        Collection.getRemoteCollectionStats(url.trim(), (err, stats) => {
            this._selectedActor[prop] = err ? -1 : (stats.totalItems || 0);
            return cb(null);
        });
    }
};

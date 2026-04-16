'use strict';

const { MenuModule } = require('../menu_module');
const { ErrorCodes } = require('../enig_error');
const Collection = require('./collection');
const { Collections } = require('./const');
const UserProps = require('../user_property');
const { sendBoost, sendLike, getBoostCount, getLikeCount, messageForNoteId, sendDelete } = require('./boost_util');
const { actorUrlToHandle } = require('./ap_search_util');
const Message = require('../message');

// deps
const async = require('async');
const moment = require('moment');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub Message Browser',
    desc: 'Browse ActivityPub messages from the Fediverse',
    author: 'NuSkooler',
};

const FormIds = { main: 0 };

const MciViewIds = {
    main: {
        list: 1, // %VM1 — scrollable message list (required)
        customRangeStart: 10,
    },
};

const Modes = {
    Federated: 'federated',
    Local: 'local',
    Timeline: 'timeline',
    Favorites: 'favorites',
    Mentions: 'mentions',
    Thread: 'thread',
};

const ModeLabelMap = {
    [Modes.Federated]: 'Federated',
    [Modes.Local]: 'Local',
    [Modes.Timeline]: 'Timeline',
    [Modes.Favorites]: 'Favorites',
    [Modes.Mentions]: 'Mentions',
    [Modes.Thread]: 'Thread',
};

const PageSize = 25;

// ─── helpers ─────────────────────────────────────────────────────────────────

//  Build the subject/summary field including [CW] or re: prefix.
function formatSubject(note) {
    const base = (note.summary || note.name || '').trim();
    if (note.sensitive) return `[CW] ${base}`;
    if (note.inReplyTo) return `re: ${base}`;
    return base;
}

//  Format a collection-row timestamp using a moment format string.
//  'am'/'pm' produced by the 'a' token are collapsed to a single char (a/p)
//  so operators can use e.g. 'MM/DD hh:mma' and get a compact suffix.
//  The empty-string fallback matches the width of the default format (12 chars).
function formatDate(ts, fmt) {
    if (!ts) return '            '; // 12 spaces — default format width
    return moment(ts).format(fmt).replace('am', 'a').replace('pm', 'p');
}

//  Right-pad or truncate a string to exactly n characters.
function padR(s, n) {
    s = String(s == null ? '' : s);
    return s.length >= n ? s.slice(0, n) : s.padEnd(n);
}

//  Format a reaction count as a display string.
//  Returns '' when zero so itemFormat's right-justify renders blank, not '0'.
//  Cap at 99 to stay within the 2-char column budget.
function fmtReaction(n) {
    return n > 0 ? String(Math.min(n, 99)) : '';
}

//
//  Build the pre-formatted display line for the VM 'text' property.
//  Used as the fallback when no itemFormat/focusItemFormat is set in the theme.
//  Fixed column layout (71 chars total — matches default 71-col VM1 art):
//    from(16) + subject(33) + date(12) + likes(2) + boosts(2) + att(1) + 5 separators
//
//  item.from and item.subject are kept untruncated on the item object so that
//  themes using itemFormat {field:<width.precision} can apply their own widths.
//
//  likes and boosts are pre-formatted strings ('' when zero, '3' etc.)
//  so right-justifying them in 2 chars naturally produces blank or a number.
//
function formatItemLine(item, indicators) {
    return (
        padR(item.from, 16) +
        ' ' +
        padR(item.subject, 33) +
        ' ' +
        padR(item.date, 12) +
        ' ' +
        String(item.likes).padStart(2) +
        ' ' +
        String(item.boosts).padStart(2) +
        ' ' +
        (item.hasAttachment ? indicators.att : ' ')
    );
}

//  Extract the embedded Note/Article from a Create or Announce activity.
//  Returns null when the object is a URL reference (not locally available).
function extractNote(activity) {
    if (!activity || typeof activity !== 'object') return null;
    const obj = activity.object;
    if (!obj || typeof obj === 'string') return null;
    if (obj.type === 'Note' || obj.type === 'Article') return obj;
    return null;
}

// ─── module ──────────────────────────────────────────────────────────────────

exports.getModule = class ActivityPubMsgListModule extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);

        //  Mode can come from extraArgs (runtime push) or config.mode (static menu entry).
        this.mode = _.get(options, 'extraArgs.mode') ||
                    _.get(this.config, 'mode', Modes.Federated);
        this.contextId = _.get(options, 'extraArgs.contextId'); // thread mode
        this.actorId = _.get(options, 'extraArgs.actorId'); // timeline mode

        //  Configurable display indicators — operator overrides via menu config.
        //  CP437 defaults: ♥ = 0x03, ▲ = 0x1E, * = attachment
        this.indicators = {
            att: _.get(this.config, 'attIndicator', '*'),
            like: _.get(this.config, 'likeIndicator', '\x03'), // ♥
            boost: _.get(this.config, 'boostIndicator', '\x1e'), // ▲
        };

        //  Timestamp format — any moment.js format string.
        //  'am'/'pm' from the 'a' token are collapsed to a single char (a/p).
        //  Default produces 12-char strings, e.g. "04/12 02:30p".
        //  If you change this to a shorter/longer format, also update your art
        //  and the itemFormat {date:} width in your theme entry.
        this.dateTimeFormat = _.get(this.config, 'dateTimeFormat', 'MM/DD hh:mma');

        this.items = [];
        this.nextCursor = null;
        this.hasMore = true;
        this.loading = false;

        //  Tracked focus index — updated by 'index update' events and when
        //  position is explicitly restored.  Used by getSaveState().
        this._focusIndex = 0;

        //  Restore focus position when returning from a sub-menu (viewer or thread).
        //  lastMenuResult.itemIndex is set by the viewer's getMenuResult() when
        //  it tracked navigation within the browser list.  savedState (via
        //  restoreSavedState) is the fallback for cases where no lastMenuResult
        //  is present (e.g. returning from thread view).
        this.restoreItemIndex = _.get(options, 'lastMenuResult.itemIndex', 0);

        this.menuMethods = {
            listKeyPressed: (formData, extraArgs, cb) => {
                const key = _.get(formData, 'key.name');
                const listView = this.getView('main', MciViewIds.main.list);
                switch (key) {
                    case 'down arrow':
                        if (listView) listView.focusNext();
                        break;
                    case 'up arrow':
                        if (listView) listView.focusPrevious();
                        break;
                    case 'page up':
                        if (listView) listView.focusPreviousPageItem();
                        break;
                    case 'page down':
                        if (listView) listView.focusNextPageItem();
                        break;
                    case 'home':
                        if (listView) listView.focusFirst();
                        break;
                    case 'end':
                        if (listView) listView.focusLast();
                        break;
                    case 'b':
                        return this._boostSelected(cb);
                    case 'l':
                        return this._likeSelected(cb);
                    case 'r':
                        return this._replySelected(cb);
                    case 'd':
                        return this._deleteSelected(cb);
                    case 't':
                    case '+':
                        return this._openThread(cb);
                    case 'return':
                    case 'space':
                        return this._openViewer(cb);
                }
                return cb(null);
            },
        };
    }

    initSequence() {
        async.series(
            [
                cb => this.beforeArt(cb),
                cb => this._displayMainPage(cb),
                cb => {
                    if (this.restoreItemIndex <= 0) return cb(null);
                    //  The first page may not contain the saved index (e.g. index 46
                    //  with PageSize 25).  Keep fetching pages until we have enough
                    //  items, then restore focus.
                    const tryRestore = () => {
                        const listView = this.getView('main', MciViewIds.main.list);
                        if (this.restoreItemIndex < this.items.length) {
                            if (listView) {
                                listView.setFocusItemIndex(this.restoreItemIndex);
                                this._focusIndex = this.restoreItemIndex;
                            }
                            return cb(null);
                        }
                        if (!this.hasMore) return cb(null); // index beyond all available items
                        this.loading = true;
                        this._loadPage(() => {
                            this.loading = false;
                            if (listView) {
                                listView.setItems(this.items);
                                listView.redraw();
                                this._updateCustomViews();
                            }
                            tryRestore();
                        });
                    };
                    tryRestore();
                },
            ],
            () => this.finishedLoading()
        );
    }

    _displayMainPage(cb) {
        async.series(
            [
                cb =>
                    this.displayArtAndPrepViewController(
                        'main',
                        FormIds.main,
                        { clearScreen: true },
                        cb
                    ),
                cb => this.validateMCIByViewIds('main', [MciViewIds.main.list], cb),
                cb => this._loadPage(cb),
                cb => {
                    const listView = this.getView('main', MciViewIds.main.list);
                    listView.setItems(this.items);
                    listView.redraw();

                    this._updateCustomViews();

                    listView.on('index update', index => {
                        //  Track current position for getSaveState().
                        this._focusIndex = index;

                        //  Lazy-load next page when within 5 items of the end.
                        //  Thread mode loads everything at once so hasMore will be false.
                        if (
                            !this.loading &&
                            this.hasMore &&
                            index >= this.items.length - 5
                        ) {
                            this.loading = true;
                            this._loadPage(() => {
                                this.loading = false;
                                listView.setItems(this.items);
                                listView.redraw();
                                this._updateCustomViews();
                            });
                        }
                    });

                    return cb(null);
                },
            ],
            err => cb(err)
        );
    }

    //  Build the format object passed to updateCustomViewTextsWithFilter.
    //  Operators place %TL10, %TL11, etc. in their art and reference these
    //  properties in their menu config format strings.
    _customFormatObject() {
        return {
            modeLabel: ModeLabelMap[this.mode] || this.mode,
            msgCount: String(this.items.length),
            attIndicator: this.indicators.att,
            likeIndicator: this.indicators.like,
            boostIndicator: this.indicators.boost,
        };
    }

    _updateCustomViews() {
        this.updateCustomViewTextsWithFilter(
            'main',
            MciViewIds.main.customRangeStart,
            this._customFormatObject()
        );
    }

    //  Fetch the next page of items and append to this.items.
    _loadPage(cb) {
        const fetchFn =
            this.mode === Modes.Thread
                ? innerCb =>
                      Collection.getCollectionByContext(
                          Collections.SharedInbox,
                          this.contextId || '',
                          innerCb
                      )
                : this.mode === Modes.Favorites
                ? innerCb =>
                      Collection.getFavoritesPage(
                          this._localActorId(),
                          { cursor: this.nextCursor, pageSize: PageSize },
                          innerCb
                      )
                : innerCb =>
                      Collection.getCollectionPage(
                          this._collectionName(),
                          {
                              cursor: this.nextCursor,
                              pageSize: PageSize,
                              filter: this._pageFilter(),
                          },
                          innerCb
                      );

        fetchFn((err, result) => {
            if (err) {
                this.client.log.error(
                    { error: err.message, mode: this.mode },
                    'AP browser: page load error'
                );
                return cb(null); // non-fatal
            }

            const { rows, nextCursor } = result;
            this.nextCursor = nextCursor;
            this.hasMore = !!nextCursor;

            //  Parse activities and extract Notes
            const noteIds = [];
            const parsed = [];

            for (const row of rows) {
                try {
                    const activity = JSON.parse(row.object_json);
                    const note = extractNote(activity);
                    if (note && note.id) {
                        noteIds.push(note.id);
                        parsed.push({ note, timestamp: row.timestamp });
                    }
                } catch (_) {
                    /* skip rows that fail to parse */
                }
            }

            if (parsed.length === 0) {
                this.client.log.warn(
                    { mode: this.mode, cursor: this.nextCursor, rowCount: rows.length },
                    'AP browser: _loadPage returned 0 usable notes'
                );
                return cb(null);
            }

            //  One GROUP BY query for all reaction counts on this page
            Collection.getReactionCountsBatch(noteIds, (err, counts) => {
                if (err) counts = new Map();

                for (const { note, timestamp } of parsed) {
                    const c = counts.get(note.id) || { likes: 0, boosts: 0 };
                    const hasAttachment =
                        Array.isArray(note.attachment) && note.attachment.length > 0;
                    const item = {
                        from: actorUrlToHandle(note.attributedTo),
                        subject: formatSubject(note),
                        date: formatDate(timestamp, this.dateTimeFormat),
                        //  Pre-formatted strings: '' when zero (blank-if-zero in itemFormat),
                        //  '3' / '99' etc. when non-zero.  {likes:>2} right-justifies correctly.
                        likes: fmtReaction(c.likes),
                        boosts: fmtReaction(c.boosts),
                        //  'att' is the display char for itemFormat {att}; hasAttachment is the boolean.
                        att: hasAttachment ? this.indicators.att : ' ',
                        hasAttachment,
                        noteId: note.id,
                        contextId: note.context || note.conversation || null,
                        inReplyTo: note.inReplyTo || null,
                    };
                    //  'text' is the default VM display string.
                    //  When itemFormat/focusItemFormat are set in the theme,
                    //  those format strings reference the properties above instead.
                    item.text = formatItemLine(item, this.indicators);
                    this.items.push(item);
                }

                return cb(null);
            });
        });
    }

    _collectionName() {
        return this.mode === Modes.Local ? Collections.Outbox : Collections.SharedInbox;
    }

    _pageFilter() {
        switch (this.mode) {
            case Modes.Timeline:
                return { actorId: this.actorId };
            case Modes.Mentions:
                return { mentionsActorId: this._localActorId() };
            default:
                return null;
        }
    }

    _localActorId() {
        return this.client.user.getProperty(UserProps.ActivityPubActorId);
    }

    _selectedItem() {
        const listView = this.getView('main', MciViewIds.main.list);
        return listView ? this.items[listView.getFocusItemIndex()] : null;
    }

    _boostSelected(cb) {
        const item = this._selectedItem();
        if (!item) return cb(null);
        sendBoost(this.client.user, item.noteId, (err) => {
            if (err) {
                if (err.code === ErrorCodes.Duplicate) {
                    this.client.log.debug({ noteId: item.noteId }, 'AP browser: already boosted');
                } else {
                    this.client.log.warn({ err: err.message }, 'AP browser: boost failed');
                }
                return cb(null);
            }
            getBoostCount(item.noteId, (err, count) => {
                if (!err) {
                    item.boosts = count > 0 ? String(Math.min(count, 99)) : '';
                    item.text = formatItemLine(item, this.indicators);
                }
                const listView = this.getView('main', MciViewIds.main.list);
                if (listView) listView.redraw();
                return cb(null);
            });
        });
    }

    _likeSelected(cb) {
        const item = this._selectedItem();
        if (!item) return cb(null);
        sendLike(this.client.user, item.noteId, (err) => {
            if (err) {
                if (err.code === ErrorCodes.Duplicate) {
                    this.client.log.debug({ noteId: item.noteId }, 'AP browser: already liked');
                } else {
                    this.client.log.warn({ err: err.message }, 'AP browser: like failed');
                }
                return cb(null);
            }
            getLikeCount(item.noteId, (err, count) => {
                if (!err) {
                    item.likes = count > 0 ? String(Math.min(count, 99)) : '';
                    item.text = formatItemLine(item, this.indicators);
                }
                const listView = this.getView('main', MciViewIds.main.list);
                if (listView) listView.redraw();
                return cb(null);
            });
        });
    }

    _replySelected(cb) {
        const item = this._selectedItem();
        if (!item || !item.noteId) return cb(null);
        messageForNoteId(item.noteId, (err, msg) => {
            if (err || !msg) {
                this.client.log.warn(
                    { noteId: item.noteId, err: err && err.message },
                    'AP browser: reply — note not found in local message DB'
                );
                return cb(null);
            }
            msg.fromUserName = actorUrlToHandle(msg.fromUserName);
            return this.gotoMenu(
                this.menuConfig.config.composeMenu || 'activityPubCompose',
                {
                    extraArgs: {
                        messageAreaTag: Message.WellKnownAreaTags.ActivityPubShared,
                        replyToMessage: msg,
                    },
                },
                cb
            );
        });
    }

    //  Save current scroll position so the parent (or ourselves on re-entry) can
    //  restore it.  Called by menu_stack.goto() before we are suspended.
    //  Uses this._focusIndex (not the view) to avoid any timing dependency on
    //  whether the view controller is still attached.
    getSaveState() {
        return { focusIndex: this._focusIndex };
    }

    //  Called by menu_stack after the new instance is created but before run().
    //  Only apply savedState when lastMenuResult didn't give us a position (i.e.
    //  we are returning from a thread browser rather than the item viewer).
    restoreSavedState(savedState) {
        if (savedState && this.restoreItemIndex === 0) {
            this.restoreItemIndex = savedState.focusIndex || 0;
        }
    }

    _deleteSelected(cb) {
        const item = this._selectedItem();
        if (!item || !item.noteId) return cb(null);

        //  Only allow deleting posts owned by the local user.
        const localHandle = actorUrlToHandle(this._localActorId());
        if (item.from !== localHandle) return cb(null);

        sendDelete(this.client.user, item.noteId, err => {
            if (err) {
                if (err.code === ErrorCodes.AccessDenied) {
                    //  Not our post — already guarded above, but handle gracefully.
                    return cb(null);
                }
                this.client.log.warn({ noteId: item.noteId, err }, 'AP browser: delete failed');
                return cb(null); // don't surface delivery errors to the user
            }

            //  Remove from local items array and redraw.
            const listView = this.getView('main', MciViewIds.main.list);
            const idx = this.items.indexOf(item);
            if (idx !== -1) this.items.splice(idx, 1);
            if (listView) {
                listView.setItems(this.items);
                listView.redraw();
            }

            return cb(null);
        });
    }

    _openThread(cb) {
        const item = this._selectedItem();
        if (!item || !item.contextId) return cb(null);
        return this.gotoMenu(
            this.menuConfig.config.threadMenu || 'activityPubThread',
            { extraArgs: { mode: Modes.Thread, contextId: item.contextId } },
            cb
        );
    }

    _openViewer(cb) {
        const listView = this.getView('main', MciViewIds.main.list);
        if (!listView) return cb(null);
        const itemIndex = listView.getFocusItemIndex();
        const item = this.items[itemIndex];
        if (!item) return cb(null);
        return this.gotoMenu(
            this.menuConfig.config.viewerMenu || 'activityPubMsgViewer',
            {
                extraArgs: {
                    item,
                    itemIndex,
                    items: this.items,
                    modeLabel: ModeLabelMap[this.mode] || this.mode,
                },
            },
            cb
        );
    }
};

'use strict';

const { MenuModule } = require('../menu_module');
const { ErrorCodes } = require('../enig_error');
const Collection = require('./collection');
const { Collections } = require('./const');
const { htmlToMessageBody } = require('./util');
const {
    sendBoost,
    sendLike,
    getBoostCount,
    getLikeCount,
    messageForNoteId,
} = require('./boost_util');
const { actorUrlToHandle } = require('./ap_search_util');
const Message = require('../message');

// deps
const async = require('async');
const moment = require('moment');
const ansi = require('../ansi_term');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'ActivityPub Message Viewer',
    desc: 'Read-only viewer for ActivityPub messages from the Fediverse',
    author: 'NuSkooler',
};

//
//  Two-part art layout mirroring FSE body+footer view mode:
//
//    config.art.body   — display art: %TL10+ header labels + %MT1 body (never directly focused)
//    config.art.footer — single-row footer art: %HM1 horizontal menu (always focused)
//
//  ViewControllers:   'body' (FormId 1), 'footer' (FormId 4)
//
//  Focus model (matches FSE view mode):
//    Footer is focused from the start — it handles ALL user input.
//    Arrow / page keys in footer actionKeys scroll the body %MT1.
//    The body VC exists only so %MT1 and %TL10+ can be read and updated.
//

const FormIds = {
    body: 1,
    footer: 4,
};

const MciViewIds = {
    body: {
        message: 1, // %MT1  — message body (preview / read-only)
        customRangeStart: 10, // %TL10+— from, subject, date, thread pos, etc.
    },
    footer: {
        menu: 1, // %HM1  — horizontal action menu
    },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatSubject(note) {
    const base = (note.summary || note.name || '').trim();
    if (note.sensitive) return `[CW] ${base}`;
    if (note.inReplyTo) return `re: ${base}`;
    return base;
}

function formatDate(ts, fmt) {
    if (!ts) return '';
    return moment(ts).format(fmt).replace('am', 'a').replace('pm', 'p');
}

function noteToItem(note, timestamp, dateTimeFormat) {
    return {
        from: actorUrlToHandle(note.attributedTo),
        subject: formatSubject(note),
        date: formatDate(timestamp, dateTimeFormat),
        noteId: note.id,
        contextId: note.context || note.conversation || null,
        inReplyTo: note.inReplyTo || null,
        hasAttachment: Array.isArray(note.attachment) && note.attachment.length > 0,
        url: note.url || note.id,
    };
}

// ─── module ──────────────────────────────────────────────────────────────────

exports.getModule = class ActivityPubMsgViewerModule extends MenuModule {
    constructor(options) {
        super(options);
        this.setConfigWithExtraArgs(options);

        this.item = _.get(options, 'extraArgs.item', null);
        this.modeLabel = _.get(options, 'extraArgs.modeLabel', '');
        this.dateTimeFormat = _.get(this.config, 'dateTimeFormat', 'MM/DD hh:mma');

        //  Display indicators — same defaults as the browser (raw CP437 bytes).
        this.indicators = {
            like: _.get(this.config, 'likeIndicator', '\x03'), // ♥
            boost: _.get(this.config, 'boostIndicator', '\x1e'), // ▲
        };

        //  List navigation — items/itemIndex passed from the browser.
        this.listItems = _.get(options, 'extraArgs.items', []);
        this.listItemIndex = _.get(options, 'extraArgs.itemIndex', 0);

        //  Thread state — lazy-loaded on first [ / ] nav.
        this.threadItems = [];
        this.threadLoaded = false;

        this.menuMethods = {
            //  ── Footer movement (form 4 actionKeys) — scrolls the body MT1 ──────
            movementKeyPressed: (formData, _extraArgs, cb) => {
                const bodyView = this._bodyView;
                if (!bodyView) return cb(null);
                switch (formData.key.name) {
                    case 'down arrow':
                        bodyView.scrollDocumentUp();
                        break;
                    case 'up arrow':
                        bodyView.scrollDocumentDown();
                        break;
                    case 'page down':
                        bodyView.keyPressPageDown();
                        break;
                    case 'page up':
                        bodyView.keyPressPageUp();
                        break;
                }
                return cb(null);
            },

            //  ── Footer HM1 submit actions (form 4) ──────────────────────────
            //  prev/next walk the browser list (same as FSE prevMessage/nextMessage)
            prevNote: (_formData, _extraArgs, cb) => {
                return this._prevListItem(cb);
            },
            nextNote: (_formData, _extraArgs, cb) => {
                return this._nextListItem(cb);
            },
            threadPrev: (_formData, _extraArgs, cb) => {
                return this._prevThreadNote(cb);
            },
            threadNext: (_formData, _extraArgs, cb) => {
                return this._nextThreadNote(cb);
            },
            boostNote: (_formData, _extraArgs, cb) => {
                if (!this.item || !this.item.noteId) return cb(null);
                sendBoost(this.client.user, this.item.noteId, err => {
                    if (err) {
                        if (err.code === ErrorCodes.Duplicate) {
                            this.client.log.debug(
                                { noteId: this.item.noteId },
                                'AP viewer: already boosted'
                            );
                        } else {
                            this.client.log.warn(
                                { err: err.message },
                                'AP viewer: boost failed'
                            );
                        }
                        return cb(null);
                    }
                    getBoostCount(this.item.noteId, (err, count) => {
                        if (!err) {
                            this.item.boosts =
                                count > 0 ? String(Math.min(count, 99)) : '';
                        }
                        this._updateCustomViews();
                        return cb(null);
                    });
                });
            },
            likeNote: (_formData, _extraArgs, cb) => {
                if (!this.item || !this.item.noteId) return cb(null);
                sendLike(this.client.user, this.item.noteId, err => {
                    if (err) {
                        if (err.code === ErrorCodes.Duplicate) {
                            this.client.log.debug(
                                { noteId: this.item.noteId },
                                'AP viewer: already liked'
                            );
                        } else {
                            this.client.log.warn(
                                { err: err.message },
                                'AP viewer: like failed'
                            );
                        }
                        return cb(null);
                    }
                    getLikeCount(this.item.noteId, (err, count) => {
                        if (!err) {
                            this.item.likes =
                                count > 0 ? String(Math.min(count, 99)) : '';
                        }
                        this._updateCustomViews();
                        return cb(null);
                    });
                });
            },
            replyNote: (_formData, _extraArgs, cb) => {
                if (!this.item || !this.item.noteId) return cb(null);
                messageForNoteId(this.item.noteId, (err, msg) => {
                    if (err || !msg) {
                        this.client.log.warn(
                            { noteId: this.item.noteId, err: err && err.message },
                            'AP viewer: reply — note not found in local message DB'
                        );
                        return cb(null);
                    }
                    msg.fromUserName = actorUrlToHandle(msg.fromUserName);
                    return this.gotoMenu(
                        this.menuConfig.config.composeMenu || 'activityPubCompose',
                        {
                            extraArgs: {
                                messageAreaTag:
                                    Message.WellKnownAreaTags.ActivityPubShared,
                                replyToMessage: msg,
                            },
                        },
                        cb
                    );
                });
            },
            quitViewer: (_formData, _extraArgs, cb) => {
                return this.prevMenu(cb);
            },
        };
    }

    getMenuResult() {
        return { itemIndex: this.listItemIndex };
    }

    get _bodyView() {
        const vc = this.viewControllers.body;
        return vc ? vc.getView(MciViewIds.body.message) : null;
    }

    get _footerStartRow() {
        return this.bodyHeight;
    }

    initSequence() {
        const art = this.menuConfig.config.art;
        if (!art || typeof art !== 'object') {
            return this.client.log.warn(
                'AP viewer: config.art must be an object with "body" and "footer" keys'
            );
        }

        const mciData = {};

        async.waterfall(
            [
                cb => this.beforeArt(cb),
                cb => {
                    this.client.term.rawWrite(ansi.goto(1, 1));
                    this.displayAsset(art.body, {}, (err, artInfo) => {
                        if (artInfo) {
                            mciData.body = artInfo;
                            this.bodyHeight = artInfo.height;
                        }
                        return cb(err);
                    });
                },
                cb => {
                    const startRow = this._footerStartRow;
                    this.client.term.rawWrite(ansi.goto(startRow, 1));
                    this.displayAsset(art.footer, { startRow }, (err, artInfo) => {
                        if (artInfo) {
                            mciData.footer = artInfo;
                        }
                        return cb(err);
                    });
                },
                cb => {
                    async.series(
                        [
                            callback =>
                                this.prepViewController(
                                    'body',
                                    FormIds.body,
                                    mciData.body.mciMap,
                                    callback
                                ),
                            callback =>
                                this.prepViewController(
                                    'footer',
                                    FormIds.footer,
                                    mciData.footer.mciMap,
                                    callback
                                ),
                        ],
                        err => cb(err)
                    );
                },
                cb => this._displayNote(cb),
                cb => {
                    //  Match FSE view mode: body is display-only, footer is always focused.
                    this.viewControllers.body.setFocus(false);
                    this.viewControllers.footer.switchFocus(MciViewIds.footer.menu);
                    return cb(null);
                },
            ],
            err => {
                if (err) {
                    this.client.log.warn({ error: err.message }, 'AP viewer init error');
                } else {
                    this.finishedLoading();
                }
            }
        );
    }

    //  Populate body text and all TL10+ custom header views.
    _displayNote(cb) {
        if (!this.item || !this.item.noteId) {
            return cb(null);
        }

        Collection.objectByEmbeddedId(this.item.noteId, (err, activity) => {
            if (err) {
                this.client.log.warn(
                    { err: err.message, noteId: this.item.noteId },
                    'AP viewer: failed to load note'
                );
            }

            const note =
                activity && typeof activity.object === 'object' ? activity.object : null;

            const bodyView = this._bodyView;
            if (bodyView) {
                const content = note
                    ? note.content || note.name || note.summary || ''
                    : '';
                bodyView.setText(content ? htmlToMessageBody(content) : '');
            }

            this._updateCustomViews();
            return cb(null);
        });
    }

    //  Format object for TL10+ custom views.
    //  Operators compose these freely via bodyInfoFormat10, bodyInfoFormat11, etc.
    //
    //  Header:   from, subject, date
    //  Counts:   likes, boosts  ('' when zero — blank-if-zero in format strings)
    //  Flags:    att (indicator char or space), hasAtt ('1' or '')
    //  Thread:   threadPos, threadTotal, threadInfo ("3 of 7"), hasPrev, hasNext
    //  Source:   modeLabel ("Federated", "Local", "Timeline", "Mentions", "Thread")
    _customFormatObject() {
        const pos = this._threadPosition();
        const item = this.item;
        return {
            //  header
            from: item ? item.from : '',
            subject: item ? item.subject : '',
            date: item ? item.date : '',
            //  reaction counts (pre-formatted: '' when zero so {likes:>2} renders blank)
            likes: item ? item.likes || '' : '',
            boosts: item ? item.boosts || '' : '',
            //  attachment
            att: item ? item.att || ' ' : ' ',
            hasAtt: item && item.hasAttachment ? '1' : '',
            //  thread position
            threadPos: pos.pos > 0 ? String(pos.pos) : '',
            threadTotal: pos.total > 0 ? String(pos.total) : '',
            threadInfo: pos.pos > 0 ? `${pos.pos} of ${pos.total}` : '',
            hasPrev: item && !!item.inReplyTo ? '1' : '',
            hasNext: this._hasNext() ? '1' : '',
            //  source mode passed from browser
            modeLabel: this.modeLabel,
            //  indicator characters (configurable, same defaults as browser)
            likeIndicator: this.indicators.like,
            boostIndicator: this.indicators.boost,
        };
    }

    _updateCustomViews() {
        this.updateCustomViewTextsWithFilter(
            'body',
            MciViewIds.body.customRangeStart,
            this._customFormatObject()
        );
    }

    //  ── Thread helpers ───────────────────────────────────────────────────────

    _threadPosition() {
        if (!this.item || !this.item.contextId || !this.threadLoaded) {
            return { pos: 0, total: 0 };
        }
        const idx = this.threadItems.findIndex(t => t.noteId === this.item.noteId);
        return {
            pos: idx >= 0 ? idx + 1 : 0,
            total: this.threadItems.length,
        };
    }

    _hasNext() {
        if (!this.item || !this.item.contextId || !this.threadLoaded) return false;
        const idx = this.threadItems.findIndex(t => t.noteId === this.item.noteId);
        return idx >= 0 && idx < this.threadItems.length - 1;
    }

    _loadThread(cb) {
        if (this.threadLoaded || !this.item || !this.item.contextId) {
            return cb(null);
        }
        Collection.getCollectionByContext(
            Collections.SharedInbox,
            this.item.contextId,
            (err, result) => {
                if (err) {
                    this.client.log.warn(
                        { err: err.message, contextId: this.item.contextId },
                        'AP viewer: thread load failed'
                    );
                    return cb(null); // non-fatal
                }
                this.threadItems = (result.rows || []).reduce((acc, row) => {
                    try {
                        const activity = JSON.parse(row.object_json);
                        const note =
                            activity && typeof activity.object === 'object'
                                ? activity.object
                                : null;
                        if (note && note.id) {
                            acc.push(
                                noteToItem(note, row.timestamp, this.dateTimeFormat)
                            );
                        }
                    } catch (_) {
                        // skip malformed rows
                    }
                    return acc;
                }, []);
                this.threadLoaded = true;
                return cb(null);
            }
        );
    }

    //  ── Navigation ──────────────────────────────────────────────────────────

    //  Walk the browser list (prev/next menu items and Enter).
    _prevListItem(cb) {
        if (!this.listItems.length || this.listItemIndex <= 0) return cb(null);
        this.listItemIndex--;
        this.item = this.listItems[this.listItemIndex];
        this.threadLoaded = false;
        this.threadItems = [];
        return this._displayNote(cb);
    }

    _nextListItem(cb) {
        if (!this.listItems.length || this.listItemIndex >= this.listItems.length - 1)
            return cb(null);
        this.listItemIndex++;
        this.item = this.listItems[this.listItemIndex];
        this.threadLoaded = false;
        this.threadItems = [];
        return this._displayNote(cb);
    }

    //  Follow inReplyTo chain ([) and thread context (]) — thread navigation.
    _prevThreadNote(cb) {
        if (!this.item || !this.item.inReplyTo) return cb(null);
        Collection.objectByEmbeddedId(this.item.inReplyTo, (err, activity, info) => {
            if (err || !activity) return cb(null);
            const note = typeof activity.object === 'object' ? activity.object : null;
            if (!note || !note.id) return cb(null);
            this.item = noteToItem(
                note,
                info ? info.timestamp : null,
                this.dateTimeFormat
            );
            this.threadLoaded = false;
            this.threadItems = [];
            return this._displayNote(cb);
        });
    }

    _nextThreadNote(cb) {
        if (!this.item || !this.item.contextId) return cb(null);
        this._loadThread(() => {
            if (!this.threadItems.length) return cb(null);
            const idx = this.threadItems.findIndex(t => t.noteId === this.item.noteId);
            if (idx < 0 || idx >= this.threadItems.length - 1) return cb(null);
            this.item = this.threadItems[idx + 1];
            return this._displayNote(cb);
        });
    }
};

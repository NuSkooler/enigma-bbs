/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const Config = require('./config.js').get;
const Events = require('./events.js');
const { getActiveConnections, AllConnections } = require('./client_connections.js');
const stringFormat = require('./string_format.js');

const { pipeToAnsi } = require('./color_codes.js');
const ansi = require('./ansi_term.js');
const SysopChat = require('./sysop_chat.js');
const Message = require('./message.js');
const User = require('./user.js');
const WfcModule = require('./wfc.js').getModule;

//  deps
const _ = require('lodash');
const async = require('async');
const { exec } = require('child_process');
const moment = require('moment');

exports.moduleInfo = {
    name: 'Page Sysop',
    desc: 'Allow users to page the sysop for chat',
    author: 'NuSkooler',
    packageName: 'codes.l33t.enigma.page_sysop',
};

//  Per-user cooldown tracking (resets on process restart — intentional)
const pageCooldowns = new Map(); // userId -> timestamp (ms)

const FormIds = {
    main: 0,
    mailConfirm: 1,
};

const MciViewIds = {
    main: {
        message: 1,     //  ET1 — optional page reason
        customRangeStart: 10,
    },
    mailConfirm: {
        confirm: 1,     //  TM1 — yes/no hotkey prompt
    },
};

exports.getModule = class PageSysopModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            sendPage: (formData, _extraArgs, cb) => this.sendPage(formData, cb),
            confirmSendMail: (formData, _extraArgs, cb) => this._confirmSendMail(formData, cb),
        };
    }

    initSequence() {
        async.series(
            [
                callback => this.displayQueuedInterruptions(callback),
                callback => this.beforeArt(callback),
                callback => this._initMain(callback),
            ],
            () => this.finishedLoading()
        );
    }

    _initMain(cb) {
        const cooldownMs = (_.get(Config(), 'sysopChat.pageCooldownMinutes', 5)) * 60 * 1000;
        const lastPage = pageCooldowns.get(this.client.user.userId);

        if (lastPage && Date.now() - lastPage < cooldownMs) {
            //  Rate limited — show art (or fallback text) then exit
            const remainingMinutes = Math.ceil((cooldownMs - (Date.now() - lastPage)) / 60000);
            const fallback = this.config.rateLimitText ||
                `|08You may only page the sysop once every |15${remainingMinutes}|08 minute(s). Please try again later.|07`;
            return this._showArtAndExit(
                this.config.rateLimitArt || 'PAGESYPLM',
                fallback,
                cb
            );
        }

        //  Remove stale view controllers from any prior visit so
        //  displayArtAndPrepViewController reinitializes them cleanly.
        this.removeViewController('main');
        this.removeViewController('mailConfirm');

        //  Skip the message-input form entirely if no sysop is available —
        //  go straight to the "send as mail?" offer.
        if (!this._isSysopAvailable()) {
            this._pendingMessage = '';
            return this._offerSendAsMail(cb);
        }

        return async.series(
            [
                callback => this.displayArtAndPrepViewController(
                    'main',
                    FormIds.main,
                    { clearScreen: true },
                    callback
                ),
                callback => this.validateMCIByViewIds(
                    'main',
                    [MciViewIds.main.message],
                    callback
                ),
                callback => {
                    const inputView = this.getView('main', MciViewIds.main.message);
                    if (inputView) {
                        this.viewControllers.main.setFocus(inputView);
                    }
                    return callback(null);
                },
            ],
            cb
        );
    }

    _isSysopAvailable() {
        return getActiveConnections(AllConnections).some(
            c => c.user.isAuthenticated() && c.user.isGroupMember('sysops') && c.user.isAvailable()
        );
    }

    _showArtAndExit(artSpec, fallbackText, cb) {
        this.displayAsset(artSpec, { clearScreen: true }, err => {
            if (err && fallbackText) {
                this.client.term.rawWrite(
                    ansi.resetScreen() +
                    pipeToAnsi(fallbackText, this.client) +
                    '\r\n'
                );
            }
            this.pausePrompt({ row: this.client.term.termHeight }, () => this.prevMenu(cb));
        });
    }

    sendPage(formData, cb) {
        const message = _.get(formData, 'value.message', '').trim();

        if (!this._isSysopAvailable()) {
            //  Sysop not available — stash the typed message and offer to send as mail
            this._pendingMessage = message;
            return this._offerSendAsMail(cb);
        }

        //  Create the pending session
        const sessionId = SysopChat.createSession(this.client, message);

        //  Record cooldown
        pageCooldowns.set(this.client.user.userId, Date.now());

        //  Emit system event
        Events.emit(Events.getSystemEvents().UserPagedSysop, {
            user: this.client.user,
            nodeId: this.client.node,
            sessionId,
            message,
        });

        this.client.log.info(
            { message },
            `Sysop paged: "${message}"`
        );

        //  Notify all online sysops (skip those already in WFC — they see it via event)
        this._notifySysops(sessionId, message);

        //  Show confirmation art then return
        return this._showArtAndExit(
            this.config.pageSentArt || 'PAGESYSPOK',
            {},
            cb
        );
    }

    //  Show combined "not available + send as mail?" art (form 1).
    _offerSendAsMail(cb) {
        return this.displayArtAndPrepViewController(
            'mailConfirm',
            FormIds.mailConfirm,
            { clearScreen: true },
            cb
        );
    }

    _confirmSendMail(formData, cb) {
        const choice = _.get(formData, 'value.confirm', 1);
        if (choice !== 0) {
            //  User declined — just exit
            return this.prevMenu(cb);
        }

        //  Build a Message pre-addressed to the sysop (userId 1)
        const subject = this.config.mailSubject || 'Page from {userName}';
        const body = this._pendingMessage || '';

        const msg = new Message({
            areaTag: Message.WellKnownAreaTags.Private,
            toUserName: this.config.sysopUserName || 'Sysop',
            fromUserName: this.client.user.username,
            subject: stringFormat(subject, { userName: this.client.user.username }),
            message: body,
            modTimestamp: moment(),
        });
        msg.setLocalFromUserId(this.client.user.userId);
        msg.setLocalToUserId(User.RootUserID);

        const mailMenuName = this.config.mailMenuName || 'privateMailMenuCreateMessage';
        return this.gotoMenu(
            mailMenuName,
            {
                extraArgs: {
                    messageAreaTag: Message.WellKnownAreaTags.Private,
                    toUserId: User.RootUserID,
                    message: msg,
                },
            },
            cb
        );
    }

    _notifySysops(sessionId, message) {
        const user = this.client.user;
        const nodeId = this.client.node;

        const sysopClients = getActiveConnections(AllConnections).filter(
            c => c.user.isAuthenticated() && c.user.isGroupMember('sysops')
        );

        if (sysopClients.length === 0) {
            return;
        }

        const notifyFormat = this.config.notifyFormat ||
            '|10Page |07from |15{userName} |08(node {nodeId})|07\r\n' +
            '|07{message}\r\n' +
            '|08Visit WFC and press |07B|08 on the node to respond.|07';

        const notifyText = stringFormat(notifyFormat, {
            userName: user.username,
            nodeId,
            message: message || '(no message)',
            sessionId,
        });

        sysopClients.forEach(c => {
            //  BEL regardless of where the sysop is
            c.term.rawWrite('\x07');

            //  Skip queuing the interrupt for sysops currently in WFC — they already
            //  receive the page via the UserPagedSysop event and see it in the node list.
            //  moduleInfo is on exports, not on instances, so use instanceof instead.
            const isAtWfc = c.currentMenuModule instanceof WfcModule;
            if (!isAtWfc) {
                c.interruptQueue.queueItem({
                    text: notifyText,
                    pause: true,
                });
            }
        });

        //  Run optional external notification command
        const notifyCmd = _.get(Config(), 'sysopChat.pageNotifyCommand', '');
        if (notifyCmd) {
            const cmd = stringFormat(notifyCmd, {
                userName: user.username,
                nodeId,
                message: message || '',
            });
            exec(cmd, err => {
                if (err) {
                    require('./logger.js').log.warn({ err, cmd }, 'sysop page notify command failed');
                }
            });
        }
    }

};

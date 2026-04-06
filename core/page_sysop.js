/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const Config = require('./config.js').get;
const Events = require('./events.js');
const { getActiveConnections, AllConnections } = require('./client_connections.js');
const stringFormat = require('./string_format.js');
const { pipeToAnsi } = require('./color_codes.js');
const SysopChat = require('./sysop_chat.js');

//  deps
const _ = require('lodash');
const async = require('async');
const { exec } = require('child_process');

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
};

const MciViewIds = {
    main: {
        message: 1,     //  ET1 — optional page reason
        availStatus: 2, //  TL2 — sysop available/unavailable indicator

        customRangeStart: 10,
    },
};

exports.getModule = class PageSysopModule extends MenuModule {
    constructor(options) {
        super(options);

        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), {
            extraArgs: options.extraArgs,
        });

        this.menuMethods = {
            sendPage: (formData, extraArgs, cb) => this.sendPage(formData, extraArgs, cb),
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
            //  Rate limited — show art then exit
            const remainingMinutes = Math.ceil((cooldownMs - (Date.now() - lastPage)) / 60000);
            return this._showArtAndExit(
                this.config.rateLimitArt || 'PAGESYPLM',
                { remainingMinutes },
                cb
            );
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
                    this._updateAvailStatus();
                    //  setText on TL2 leaves the physical cursor at that view's position;
                    //  re-focus ET1 to restore the cursor to the input field.
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

    _updateAvailStatus() {
        const availView = this.getView('main', MciViewIds.main.availStatus);
        if (!availView) {
            return;
        }

        const isSysopAvailable = this._isSysopAvailable();
        const config = this.config;
        const text = isSysopAvailable
            ? (config.availableText || '|10Available|07')
            : (config.notAvailableText || '|08Not Available|07');

        availView.setText(pipeToAnsi(text, this.client));
    }

    _isSysopAvailable() {
        return getActiveConnections(AllConnections).some(
            c => c.user.isAuthenticated() && c.user.isGroupMember('sysops') && c.user.isAvailable()
        );
    }

    _showArtAndExit(artSpec, extraFmt, cb) {
        this.displayAsset(artSpec, { clearScreen: true }, () => {
            this.pausePrompt(() => this.prevMenu(cb));
        });
    }

    sendPage(formData, extraArgs, cb) {
        const message = _.get(formData, 'value.message', '').trim();

        if (!this._isSysopAvailable()) {
            return this._showArtAndExit(
                this.config.notAvailableArt || 'PAGESYPNA',
                {},
                cb
            );
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

        //  Notify all online sysops
        this._notifySysops(sessionId, message);

        //  Show confirmation art then return
        return this._showArtAndExit(
            this.config.pageSentArt || 'PAGESYPOK',
            {},
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

        //  BEL + interrupt to every online sysop
        const notifyFormat = this.config.notifyFormat ||
            '|08[|10Page|08] |15{userName}|07 on node |15{nodeId}|07 wants to chat.|07\r\n|07Visit WFC (press |15B|07 on selected node) to respond.';

        const notifyText = stringFormat(notifyFormat, {
            userName: user.username,
            nodeId,
            message: message || '(no message)',
            sessionId,
        });

        sysopClients.forEach(c => {
            //  BEL
            c.term.rawWrite('\x07');
            //  Interrupt
            c.interruptQueue.queueItem({
                text: notifyText,
                pause: true,
            });
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
                    //  Non-fatal; log but don't interrupt flow
                    require('./logger.js').log.warn({ err, cmd }, 'sysop page notify command failed');
                }
            });
        }
    }

};

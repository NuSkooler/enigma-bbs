'use strict';

const { MessageScanTossModule } = require('../msg_scan_toss_module');
const Message = require('../message');
const {
    WellKnownAreaTags,
    AddressFlavor,
    SystemMetaNames,
    WellKnownMetaCategories,
    StateFlags0,
} = require('../message_const');
const { persistMessage } = require('../message_area');
const { sendMail } = require('../email');
const User = require('../user');
const Config = require('../config').get;
const Log = require('../logger').log;
const { stripAnsiControlCodes } = require('../string_util');
const { stripMciColorCodes } = require('../color_codes');

//  deps
const { ImapFlow } = require('imapflow');
const PostalMime = require('postal-mime').default;
const { stripHtml } = require('string-strip-html');
const fse = require('fs-extra');
const paths = require('path');
const _ = require('lodash');

exports.moduleInfo = {
    name: 'Email',
    desc: 'Provides Email scanner/tosser integration',
    author: 'NuSkooler',
};

const DefaultPollIntervalMs = 5 * 60 * 1000;
const DefaultMaxMessagesPerRun = 50;

exports.getModule = class EmailScannerTosser extends MessageScanTossModule {
    constructor() {
        super();
        this.log = Log.child({ module: 'EmailScannerTosser' });
        this._pollTimer = null;
        this._idleClient = null;
        this._polling = false;
    }

    startup(cb) {
        const inbound = this._inboundConfig();
        if (!inbound) {
            return cb(null);
        }

        const failedDir = this._failedDir();
        fse.mkdirs(failedDir, err => {
            if (err) {
                this.log.warn(
                    { err, failedDir },
                    'Failed to create email failed/ directory'
                );
            }
            this._startInbound();
            return cb(null);
        });
    }

    shutdown(cb) {
        this._stopInbound();
        return cb(null);
    }

    record(message) {
        if (!this._shouldExportMessage(message)) {
            return;
        }
        this._exportMessage(message);
    }

    //  --- private ---

    _config() {
        return _.get(Config(), 'email', null);
    }

    _inboundConfig() {
        const config = this._config();
        if (!_.get(config, 'inbound.enabled', false)) {
            return null;
        }
        return config.inbound;
    }

    _failedDir() {
        const config = Config();
        return paths.join(
            _.get(
                config,
                'paths.emailInbound',
                paths.join(__dirname, '../../mail/email/')
            ),
            'failed'
        );
    }

    _shouldExportMessage(message) {
        //  Only export private messages addressed to an email recipient that
        //  were composed locally (not imported from the outside).
        return (
            message.isPrivate() &&
            message.getAddressFlavor() === AddressFlavor.Email &&
            !message.isFromRemoteUser()
        );
    }

    _exportMessage(message) {
        const config = this._config();
        if (!config || !_.has(config, 'transport')) {
            this.log.warn('Email transport not configured; cannot export message');
            return message.persistMetaValue(
                WellKnownMetaCategories.System,
                SystemMetaNames.StateFlags0,
                StateFlags0.ExportFailed.toString(),
                () => {}
            );
        }

        const toAddress = message.getRemoteToUser();
        if (!toAddress) {
            return;
        }

        const bodyText = stripMciColorCodes(
            stripAnsiControlCodes(message.message || '', { all: true })
        );

        const mailOptions = {
            to: toAddress,
            subject: message.subject || '(no subject)',
            text: bodyText,
        };

        const fromAddress = this._buildFromAddress(config, message.fromUserName);
        if (fromAddress) {
            mailOptions.from = fromAddress;
            //  Honest third-party submission: receivers show "X on behalf of Y"
            //  and bounces go to the authenticated mailbox rather than the user.
            if (config.defaultFrom) {
                mailOptions.sender = config.defaultFrom;
            }
        }

        sendMail(mailOptions, err => {
            if (err) {
                this.log.warn({ err, toAddress }, 'Failed to send outbound email');
                return message.persistMetaValue(
                    WellKnownMetaCategories.System,
                    SystemMetaNames.StateFlags0,
                    StateFlags0.ExportFailed.toString(),
                    () => {}
                );
            }

            this.log.info({ toAddress }, 'Outbound email sent');
            return message.persistMetaValue(
                WellKnownMetaCategories.System,
                SystemMetaNames.StateFlags0,
                StateFlags0.Exported.toString(),
                () => {}
            );
        });
    }

    _buildFromAddress(emailConfig, fromUserName) {
        const fromDomain = _.get(emailConfig, 'outbound.fromDomain');
        if (!fromDomain || !fromUserName) {
            return null;
        }

        const replaceChar = _.get(emailConfig, 'outbound.usernameReplaceChar', '_');
        const localPart = this._sanitizeLocalPart(fromUserName, replaceChar);
        if (!localPart) {
            return null;
        }

        const bannedNames = _.get(Config(), 'users.badUserNames', []);
        if (bannedNames.includes(localPart.toLowerCase())) {
            this.log.warn(
                { fromUserName, localPart },
                'Sanitized local-part is a reserved/banned name; falling back to defaultFrom'
            );
            return null;
        }

        return {
            name: fromUserName,
            address: `${localPart}@${fromDomain}`,
        };
    }

    _sanitizeLocalPart(name, replaceChar) {
        //  RFC 5321 local-parts allow a broader set, but restrict to the
        //  conservative subset (letters, digits, dot, hyphen, underscore)
        //  that virtually every receiver handles without surprise.
        let local = String(name).replace(/[^a-zA-Z0-9._-]+/g, replaceChar);
        //  Trim leading/trailing separators and collapse repeats
        local = local.replace(/^[._-]+|[._-]+$/g, '');
        if (replaceChar) {
            const esc = replaceChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            local = local.replace(new RegExp(`${esc}{2,}`, 'g'), replaceChar);
        }
        return local;
    }

    _startInbound() {
        const inbound = this._inboundConfig();
        if (!inbound || !inbound.imap) {
            return;
        }

        const pollInterval = _.get(inbound, 'imap.pollIntervalMs', DefaultPollIntervalMs);

        if (pollInterval === 0) {
            this._startIdleConnection();
        } else {
            //  Run once immediately, then on interval
            this._runPoll();
            this._pollTimer = setInterval(() => this._runPoll(), pollInterval);
        }
    }

    _stopInbound() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._idleClient) {
            this._idleClient.close();
            this._idleClient = null;
        }
    }

    _runPoll() {
        if (this._polling) {
            return;
        }
        this._polling = true;
        this._pollInbound()
            .catch(err => this.log.warn({ err }, 'IMAP poll error'))
            .finally(() => {
                this._polling = false;
            });
    }

    async _pollInbound() {
        const inbound = this._inboundConfig();
        if (!inbound || !inbound.imap) {
            return;
        }

        const imapConfig = inbound.imap;
        const client = new ImapFlow({
            host: imapConfig.host,
            port: imapConfig.port || 993,
            secure: imapConfig.secure !== false,
            auth: {
                user: imapConfig.user,
                pass: imapConfig.password,
            },
            logger: false,
        });

        //  ImapFlow emits 'error' on unexpected socket drops in addition to
        //  rejecting the in-flight Promise. Without a listener, Node treats
        //  it as uncaught and kills the process.
        client.on('error', err => this.log.warn({ err }, 'IMAP client error'));

        try {
            await client.connect();

            const lock = await client.getMailboxLock('INBOX');
            try {
                const unseenUids = await client.search({ seen: false }, { uid: true });
                if (!unseenUids || unseenUids.length === 0) {
                    return;
                }

                const maxMessages = _.get(
                    inbound,
                    'imap.maxMessagesPerRun',
                    DefaultMaxMessagesPerRun
                );
                const uidsToProcess = unseenUids.slice(0, maxMessages);
                const messages = await client.fetchAll(
                    uidsToProcess,
                    { uid: true, envelope: true, source: true, flags: true },
                    { uid: true }
                );

                for (const rawMsg of messages) {
                    const imported = await this._importMessage(rawMsg.source);

                    //  Mark seen on both success and failure so a repeatedly-
                    //  failing message (unknown recipient, parse error) does not
                    //  get re-fetched on every poll and duplicated into failed/.
                    await client.messageFlagsAdd(rawMsg.uid, ['\\Seen'], {
                        uid: true,
                    });

                    const destFolder = imported
                        ? _.get(imapConfig, 'processedFolder')
                        : _.get(imapConfig, 'failedFolder');
                    if (destFolder) {
                        await client
                            .messageMove([rawMsg.uid], destFolder, { uid: true })
                            .catch(err =>
                                this.log.warn(
                                    { err, destFolder, imported },
                                    'Could not move message to destination folder'
                                )
                            );
                    }
                }
            } finally {
                lock.release();
            }
        } finally {
            await client.logout().catch(() => {});
        }
    }

    async _importMessage(source) {
        try {
            const parser = new PostalMime();
            const email = await parser.parse(source);

            const toAddresses = email.to || [];
            const recipient = await this._resolveRecipient(toAddresses);

            if (!recipient) {
                this.log.info(
                    { to: toAddresses.map(a => a.address) },
                    'Inbound email has no matching local user; saving to failed/'
                );
                await this._saveFailedMessage(source, 'no_user');
                return false;
            }

            const fromAddress =
                _.get(email, 'from.address') ||
                _.get(email, 'from.text', 'unknown@unknown');
            const fromName = _.get(email, 'from.name') || fromAddress;

            const body =
                email.text || (email.html ? stripHtml(email.html).result : '(no body)');
            const subject = email.subject || '(no subject)';

            const message = new Message({
                areaTag: WellKnownAreaTags.Private,
                toUserName: recipient.username,
                fromUserName: fromName,
                subject,
                message: body,
            });

            message.setLocalToUserId(recipient.userId);
            message.setRemoteFromUser(fromAddress);
            message.setExternalFlavor(AddressFlavor.Email);
            message.meta[WellKnownMetaCategories.System][SystemMetaNames.StateFlags0] =
                StateFlags0.Imported.toString();

            await new Promise((resolve, reject) => {
                persistMessage(message, err => (err ? reject(err) : resolve()));
            });

            this.log.info(
                { to: recipient.username, from: fromAddress },
                'Imported inbound email'
            );
            return true;
        } catch (err) {
            this.log.warn({ err }, 'Failed to import inbound email');
            return false;
        }
    }

    async _resolveRecipient(toAddresses) {
        for (const addr of toAddresses) {
            const userPart = (addr.address || '').split('@')[0];
            if (!userPart) {
                continue;
            }

            const result = await new Promise(resolve => {
                User.getUserIdAndName(userPart, (err, userId, username) => {
                    resolve(err || !userId ? null : { userId, username });
                });
            });

            if (result) {
                return result;
            }
        }
        return null;
    }

    async _saveFailedMessage(source, reason) {
        const failedDir = this._failedDir();
        const filename = `${Date.now()}_${reason}.eml`;
        try {
            await fse.writeFile(paths.join(failedDir, filename), source);
        } catch (err) {
            this.log.warn({ err }, 'Could not write failed email to disk');
        }
    }

    _startIdleConnection() {
        const inbound = this._inboundConfig();
        if (!inbound || !inbound.imap) {
            return;
        }

        const connect = async () => {
            const imapConfig = inbound.imap;
            const client = new ImapFlow({
                host: imapConfig.host,
                port: imapConfig.port || 993,
                secure: imapConfig.secure !== false,
                auth: {
                    user: imapConfig.user,
                    pass: imapConfig.password,
                },
                logger: false,
            });

            client.on('error', err => this.log.warn({ err }, 'IMAP IDLE client error'));

            this._idleClient = client;

            try {
                await client.connect();
                await client.getMailboxLock('INBOX');

                client.on('exists', () => this._runPoll());

                client.on('close', () => {
                    this.log.info('IMAP IDLE connection closed; reconnecting in 15s');
                    this._idleClient = null;
                    setTimeout(connect, 15000);
                });

                this.log.info(
                    { host: imapConfig.host },
                    'IMAP IDLE connection established'
                );
            } catch (err) {
                this.log.warn({ err }, 'IMAP IDLE connection failed; retrying in 30s');
                this._idleClient = null;
                setTimeout(connect, 30000);
            }
        };

        connect().catch(err =>
            this.log.warn({ err }, 'IMAP IDLE initial connect failed')
        );
    }
};

/* jslint node: true */
'use strict';

const _ = require('lodash');
const { MenuModule } = require('../core/menu_module.js');
const Config = require('../core/config.js').get;
const UserProps = require('../core/user_property.js');
const {
    getMessageAreaByTag,
    hasMessageConfAndAreaRead,
} = require('../core/message_area.js');

const notificationDb = require('./notification_db');

const START_ROW = 16;
const START_COL = 2;

exports.moduleInfo = {
    name: 'Notification Settings Menu',
    desc: 'Per-area email notification settings',
    author: 'OpenAI',
};

const PROMPT_VIEW_ID = 2;
const MAX_RENDER_LINES = 10;

const C_RESET  = '\x1b[0m';
const C_WHITE  = '\x1b[97m';
const C_YELLOW = '\x1b[93m';
const C_GREEN  = '\x1b[92m';
const C_RED    = '\x1b[91m';
const C_GREY   = '\x1b[90m';

function colorize(text, color) {
    return `${color}${text}${C_RESET}`;
}

function stateValueLabel(enabled, allowed) {
    if (!allowed) {
        return colorize('--', C_GREY);
    }

    return enabled ? colorize('ON', C_GREEN) : colorize('OFF', C_RED);
}


function gotoAnsi(row, col) {
    return `\u001b[${row};${col}H`;
}

function eraseLineAnsi() {
    return '\u001b[2K';
}

function padRight(text, width) {
    const value = String(text || '');
    if (value.length >= width) {
        return value.slice(0, width);
    }
    return value + ' '.repeat(width - value.length);
}

function stateLabel(value, allowed) {
    if (!allowed) {
        return '--';
    }

    return value ? 'ON ' : 'OFF';
}

function sanitizeCommand(rawCommand) {
    return String(rawCommand || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
}

function parseToggleCommand(rawCommand) {
    const command = sanitizeCommand(rawCommand);

    if (!command) {
        return { type: 'noop', raw: command };
    }

    if (['Q', 'QUIT', 'EXIT'].includes(command)) {
        return { type: 'quit', raw: command };
    }

    if (['?', 'H', 'HELP'].includes(command)) {
        return { type: 'help', raw: command };
    }

    let match = command.match(/^(\d{1,2})([NR])$/);
    if (!match) {
        match = command.match(/^([NR])(\d{1,2})$/);
        if (match) {
            match = [match[0], match[2], match[1]];
        }
    }

    if (!match) {
        return { type: 'invalid', raw: command };
    }

    return {
        type: 'toggle',
        index: parseInt(match[1], 10),
        toggleKey: 'N' === match[2] ? 'new_post_email' : 'reply_to_own_post_email',
        raw: command,
    };
}

exports.getModule = class NotificationSettingsMenu extends MenuModule {
    constructor(options) {
        super(options);

        this.areaEntries = [];
        this.statusMessage = _.get(options, 'extraArgs.statusMessage', '');

        this.menuMethods.handleCommand = (formData, extraArgs, cb) => {
            this.handleCommand(formData, cb).catch(err => cb(err));
        };
    }

    mciReady(mciData, cb) {
        return this.standardMCIReadyHandler(mciData, err => {
            if (err) {
                return cb(err);
            }

            this.renderMenu()
                .then(() => cb(null))
                .catch(cb);
        });
    }

    async getAvailableNotificationAreas() {
        const config = Config();
        const conferences = _.get(config, 'messageConferences', {});
        const userId = _.get(this.client, 'user.userId', 0);
        const entries = [];

        for (const [confTag, confConfig] of Object.entries(conferences)) {
            const confSort = parseInt(_.get(confConfig, 'sort', 9999), 10) || 9999;
            const confName = _.get(confConfig, 'name', confTag);
            const areas = _.get(confConfig, 'areas', {});

            for (const [areaTag, rawAreaConfig] of Object.entries(areas)) {
                const areaConfig = getMessageAreaByTag(areaTag) || rawAreaConfig;
                const allowNewTopicEmail = true === _.get(areaConfig, 'notifications.allowNewTopicEmail', false);
                const allowReplyToOwnPostEmail = true === _.get(areaConfig, 'notifications.allowReplyToOwnPostEmail', false);

                if (!allowNewTopicEmail && !allowReplyToOwnPostEmail) {
                    continue;
                }

                if (!hasMessageConfAndAreaRead(this.client, areaConfig)) {
                    continue;
                }

                const settings = await notificationDb.getUserAreaNotificationSettings(userId, areaTag);
                const areaSort = parseInt(_.get(areaConfig, 'sort', 9999), 10) || 9999;
                const areaName = _.get(areaConfig, 'name', areaTag);

                entries.push({
                    confTag,
                    confName,
                    confSort,
                    areaTag,
                    areaName,
                    areaSort,
                    allowNewTopicEmail,
                    allowReplyToOwnPostEmail,
                    new_post_email: !!settings.new_post_email,
                    reply_to_own_post_email: !!settings.reply_to_own_post_email,
                });
            }
        }

        entries.sort((a, b) => {
            if (a.confSort !== b.confSort) {
                return a.confSort - b.confSort;
            }
            if (a.areaSort !== b.areaSort) {
                return a.areaSort - b.areaSort;
            }
            return a.areaName.localeCompare(b.areaName);
        });

        return entries;
    }

    getUserEmailNotice() {
        const email = _.get(this.client, ['user', 'properties', UserProps.EmailAddress], '');
        if (_.isString(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            return `E-Mail address: ${email.trim()}`;
        }

        return 'Warning: no valid e-mail address found in your user profile.';
    }

    buildRenderLines() {
        const lines = [];
       // lines.push('Notifications');
        lines.push('');
        //lines.push(this.getUserEmailNotice());
       // lines.push('Use 1N / 1R to toggle: N = new posts, R = replies. Q = quit.');
       	const emailNotice = this.getUserEmailNotice();
const emailPrefix = 'E-Mail address: ';

if (emailNotice.startsWith(emailPrefix)) {
    const emailValue = emailNotice.slice(emailPrefix.length);

    lines.push(
        `${C_RESET}${colorize(emailPrefix, C_WHITE)}${colorize(emailValue, C_YELLOW)}${C_RESET}`
    );
} else {
    lines.push(`${C_RESET}${colorize(emailNotice, C_WHITE)}${C_RESET}`);
}

	 lines.push('');

        if (this.areaEntries.length < 1) {
            lines.push('No message areas with notification options are available for this user.');
        } else {
            for (let i = 0; i < this.areaEntries.length; i += 1) {
    const entry = this.areaEntries[i];
    const index = String(i + 1).padStart(2, '0');

    const leftPlain = `${index} ${entry.areaName}`;
	const confPlain = ` (${entry.confName})`;

	const titlePlain = `${leftPlain}${confPlain}`;
	const titlePadded = padRight(titlePlain, 52);

	const leftPart = titlePadded.slice(0, leftPlain.length);
	const confPart = titlePadded.slice(leftPlain.length, leftPlain.length + confPlain.length);
	const tailPart = titlePadded.slice(leftPlain.length + confPlain.length);

	const titleColored =
    `${colorize(leftPart, C_YELLOW)}${colorize(confPart, C_GREY)}${tailPart}`;

    const nLabel = colorize('N:', C_WHITE);
    const rLabel = colorize('R:', C_WHITE);

    const nValue = stateValueLabel(
        entry.new_post_email,
        entry.allowNewTopicEmail
    );

    const rValue = stateValueLabel(
        entry.reply_to_own_post_email,
        entry.allowReplyToOwnPostEmail
    );

    lines.push(`${titleColored} ${nLabel}${nValue}  ${rLabel}${rValue}`);
}
        }

        lines.push('');
        lines.push(this.statusMessage || '');

        while (lines.length < MAX_RENDER_LINES) {
            lines.push('');
        }

        return lines.slice(0, MAX_RENDER_LINES);
    }

    writeRenderLines(lines) {
    const output = [];

    for (let i = 0; i < MAX_RENDER_LINES; i += 1) {
        output.push(gotoAnsi(START_ROW + i, START_COL));
        output.push(eraseLineAnsi());
        output.push(lines[i] || '');
    }

    this.client.term.rawWrite(output.join(''));
}

    clearPromptInput() {
        const promptView = this.getView('prompt', PROMPT_VIEW_ID);
        if (promptView) {
            promptView.setText('');
            promptView.setFocus(true);
        }
    }

    async renderMenu() {
        this.areaEntries = await this.getAvailableNotificationAreas();
        this.writeRenderLines(this.buildRenderLines());
        this.clearPromptInput();
    }

    async handleCommand(formData, cb) {
        const rawCommand = _.get(formData, 'value.command', '');
        const command = parseToggleCommand(rawCommand);

        if ('noop' === command.type) {
            this.statusMessage = 'Please enter a command such as 1N, 1R, or Q.';
            await this.renderMenu();
            return cb(null);
        }

        if ('quit' === command.type) {
            return this.prevMenu(cb);
        }

        if ('help' === command.type) {
            this.statusMessage = 'Commands: 1N toggles new-post mail, 1R toggles reply mail, Q leaves this page.';
            await this.renderMenu();
            return cb(null);
        }

        if ('invalid' === command.type) {
            this.statusMessage = `Unknown command: ${rawCommand}`;
            await this.renderMenu();
            return cb(null);
        }

        const entry = this.areaEntries[command.index - 1];
        if (!entry) {
            this.statusMessage = `No area found for index ${command.index}.`;
            await this.renderMenu();
            return cb(null);
        }

        if ('new_post_email' === command.toggleKey && !entry.allowNewTopicEmail) {
            this.statusMessage = `New-post e-mail is not offered for ${entry.areaName}.`;
            await this.renderMenu();
            return cb(null);
        }

        if ('reply_to_own_post_email' === command.toggleKey && !entry.allowReplyToOwnPostEmail) {
            this.statusMessage = `Reply e-mail is not offered for ${entry.areaName}.`;
            await this.renderMenu();
            return cb(null);
        }

        const userId = _.get(this.client, 'user.userId', 0);
        const current = await notificationDb.getUserAreaNotificationSettings(userId, entry.areaTag);
        const nextSettings = {
            new_post_email: !!current.new_post_email,
            reply_to_own_post_email: !!current.reply_to_own_post_email,
        };

        nextSettings[command.toggleKey] = !nextSettings[command.toggleKey];

        await notificationDb.setUserAreaNotificationSettings(userId, entry.areaTag, nextSettings);

        const changedLabel = 'new_post_email' === command.toggleKey
            ? 'new posts'
            : 'replies';
        const changedState = nextSettings[command.toggleKey] ? 'enabled' : 'disabled';

        this.statusMessage = `${entry.areaName}: ${changedLabel} mail ${changedState}.`;
        await this.renderMenu();
        return cb(null);
    }
};

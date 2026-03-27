/* jslint node: true */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const notificationDb = require('./notification_db');

const DEBUG_LOG_PATH = '/home/enigma/enigma-bbs/logs/notification_debug.log';
const WORKER_RUN_LOCK_KEY = 'mail_worker_run_lock';
const WORKER_LAST_POLL_TS_KEY = 'mail_worker_last_poll_ts';

let scheduledRunInProgress = false;

function nowIso() {
    return new Date().toISOString();
}

function isoAfterMs(baseIso, offsetMs) {
    return new Date(new Date(baseIso).getTime() + offsetMs).toISOString();
}

function toPositiveInt(value, fallback) {
    const numeric = parseInt(value, 10) || 0;
    return numeric > 0 ? numeric : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function appendDebugLog(message) {
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}
`);
    } catch (err) {
        // ignore debug log errors; worker must still continue
    }
}

function getEnigmaLogger() {
    try {
        const loggerModule = require('../core/logger.js');
        const candidate = loggerModule.log || loggerModule.logger || loggerModule;
        if (candidate && _.isFunction(candidate.info) && _.isFunction(candidate.warn) && _.isFunction(candidate.error)) {
            return candidate;
        }
    } catch (err) {
        // ignore; logger is optional for this module
    }

    return null;
}

function getLogger(logger) {
    if (logger && _.isFunction(logger.info) && _.isFunction(logger.warn) && _.isFunction(logger.error)) {
        return logger;
    }

    const enigmaLogger = getEnigmaLogger();
    if (enigmaLogger) {
        return enigmaLogger;
    }

    return {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    };
}

function serializeError(err) {
    if (!err) {
        return 'Unknown error';
    }

    if (_.isString(err)) {
        return err;
    }

    if (err.stack) {
        return err.stack.slice(0, 4000);
    }

    if (err.message) {
        return err.message.slice(0, 4000);
    }

    return String(err).slice(0, 4000);
}

function calculateRetryDelayMs(attempts, options = {}) {
    const retryBaseMs = toPositiveInt(options.retryBaseMs, 60000);
    const retryMaxMs = toPositiveInt(options.retryMaxMs, 3600000);
    const normalizedAttempts = Math.max(1, parseInt(attempts, 10) || 1);
    const delay = retryBaseMs * Math.pow(2, normalizedAttempts - 1);

    return Math.min(delay, retryMaxMs);
}

function getMinSendIntervalMs(options = {}) {
    return toPositiveInt(options.minSendIntervalMs, 15000);
}

function getConfigModule() {
    try {
        return require('../core/config.js');
    } catch (err) {
        throw new Error(`Unable to load ENiGMA config module: ${err.message}`);
    }
}

async function ensureConfigInitialized(options = {}) {
    const configModule = getConfigModule();

    if (_.isFunction(configModule.get)) {
        return configModule.get();
    }

    if (!configModule.Config || !_.isFunction(configModule.Config.create)) {
        throw new Error('ENiGMA config module does not expose Config.create()');
    }

    let resolvePath;
    try {
        resolvePath = require('../core/misc_util.js').resolvePath;
    } catch (err) {
        throw new Error(`Unable to load ENiGMA misc util module: ${err.message}`);
    }

    const configTarget =
        options.configPath ||
        process.env.ENIGMA_CONFIG ||
        process.env.ENIGMA_CONFIG_PATH ||
        configModule.Config.getDefaultPath();

    const configFile = /config\.hjson$/i.test(configTarget)
        ? configTarget
        : path.join(configTarget, 'config.hjson');

    await new Promise((resolve, reject) => {
        configModule.Config.create(resolvePath(configFile), err => {
            if (err) {
                return reject(err);
            }
            return resolve();
        });
    });

    if (!_.isFunction(configModule.get)) {
        throw new Error('ENiGMA config initialized, but Config.get() is unavailable');
    }

    return configModule.get();
}

function loadEnigmaConfig() {
    const configModule = getConfigModule();

    if (_.isFunction(configModule.get)) {
        return configModule.get();
    }

    throw new Error('ENiGMA config not initialized; call ensureConfigInitialized() first');
}

function resolveRuntimeConfig(options = {}) {
    if (options.config) {
        return options.config;
    }

    return loadEnigmaConfig();
}

function getMailWorkerConfig(options = {}) {
    const config = resolveRuntimeConfig(options);
    return _.get(config, 'email.mailworker', {});
}

function applyConfigDefaults(options = {}) {
    const workerConfig = getMailWorkerConfig(options);

    return Object.assign({}, options, {
        maxJobs: options.maxJobs || workerConfig.maxJobs,
        leaseMs: options.leaseMs || workerConfig.leaseMs,
        maxAttempts: options.maxAttempts || workerConfig.maxAttempts,
        retryBaseMs: options.retryBaseMs || workerConfig.retryBaseMs,
        retryMaxMs: options.retryMaxMs || workerConfig.retryMaxMs,
        minSendIntervalMs: options.minSendIntervalMs || workerConfig.minSendIntervalMs,
        runLockMs: options.runLockMs || workerConfig.runLockMs || (toPositiveInt(workerConfig.runLockSec, 0) * 1000),
        polltime: options.polltime || workerConfig.polltime,
    });
}

function createTransport(options = {}) {
    if (_.isFunction(options.transportFactory)) {
        return options.transportFactory(options);
    }

    const config = resolveRuntimeConfig(options);
    const transportConfig = _.get(config, 'email.transport');

    if (!transportConfig) {
        throw new Error('Missing config.email.transport for notification worker');
    }

    let nodemailer;
    try {
        nodemailer = require('nodemailer');
    } catch (err) {
        throw new Error(`Unable to load nodemailer: ${err.message}`);
    }

    return nodemailer.createTransport(transportConfig);
}

function getDefaultFrom(options = {}) {
    if (options.defaultFrom) {
        return options.defaultFrom;
    }

    const config = resolveRuntimeConfig(options);
    const configuredFrom = _.get(config, 'email.defaultFrom', '');

    if (!configuredFrom) {
        throw new Error('Missing config.email.defaultFrom for notification worker');
    }

    return configuredFrom;
}

function buildMailPayload(job, options = {}) {
    const from = getDefaultFrom(options);

    return {
        from,
        to: job.recipient_email,
        subject: job.subject,
        text: job.body,
    };
}

async function sendMailForJob(job, transport, options = {}) {
    if (!transport || !_.isFunction(transport.sendMail)) {
        throw new Error('Mail transport does not expose sendMail()');
    }

    return transport.sendMail(buildMailPayload(job, options));
}

async function getThrottleState(options = {}) {
    const minSendIntervalMs = getMinSendIntervalMs(options);
    const state = await notificationDb.getStateValue('last_sent_ts');
    const lastSentTs = _.get(state, 'state_value', '');

    if (!lastSentTs) {
        return {
            throttled: false,
            lastSentTs: null,
            nextEligibleTs: null,
        };
    }

    const elapsedMs = Date.now() - new Date(lastSentTs).getTime();
    if (elapsedMs >= minSendIntervalMs) {
        return {
            throttled: false,
            lastSentTs,
            nextEligibleTs: null,
        };
    }

    return {
        throttled: true,
        lastSentTs,
        nextEligibleTs: isoAfterMs(lastSentTs, minSendIntervalMs),
    };
}

async function processLeasedJob(job, transport, options = {}) {
    const logger = getLogger(options.logger);
    const maxAttempts = toPositiveInt(options.maxAttempts, 5);

    appendDebugLog(
        `WORKER SEND START jobId=${job.id} messageId=${job.message_id} to=${job.recipient_email} attempts=${job.attempts}`
    );

    try {
        const info = await sendMailForJob(job, transport, options);
        const sentTs = nowIso();
        const updated = await notificationDb.markNotificationSent(job.id, sentTs);

        if (!updated) {
            throw new Error(`Could not mark notification job ${job.id} as sent`);
        }

        await notificationDb.setStateValue('last_sent_ts', sentTs);

        appendDebugLog(
            `WORKER SEND OK jobId=${job.id} messageId=${job.message_id} to=${job.recipient_email} response=${_.get(info, 'response', 'n/a')}`
        );

        logger.info(
            {
                jobId: job.id,
                messageId: job.message_id,
                recipientUserId: job.recipient_user_id,
                recipientEmail: job.recipient_email,
            },
            'Notification email sent'
        );

        return {
            processed: true,
            status: 'sent',
            jobId: job.id,
            messageId: job.message_id,
            attempts: job.attempts,
            transportResponse: _.get(info, 'response', null),
        };
    } catch (err) {
        const errText = serializeError(err);
        const nowTs = nowIso();

        if ((parseInt(job.attempts, 10) || 0) >= maxAttempts) {
            const markedFailed = await notificationDb.markNotificationFailed(job.id, errText, nowTs);

            if (!markedFailed) {
                throw new Error(`Could not mark notification job ${job.id} as failed`);
            }

            appendDebugLog(
                `WORKER SEND FAILED jobId=${job.id} messageId=${job.message_id} attempts=${job.attempts} error=${errText}`
            );

            logger.error(
                {
                    jobId: job.id,
                    messageId: job.message_id,
                    attempts: job.attempts,
                    error: errText,
                },
                'Notification email permanently failed'
            );

            return {
                processed: true,
                status: 'failed',
                jobId: job.id,
                messageId: job.message_id,
                attempts: job.attempts,
                error: errText,
            };
        }

        const retryDelayMs = calculateRetryDelayMs(job.attempts, options);
        const retryAtTs = isoAfterMs(nowTs, retryDelayMs);
        const markedRetry = await notificationDb.markNotificationForRetry(
            job.id,
            errText,
            retryAtTs,
            nowTs
        );

        if (!markedRetry) {
            throw new Error(`Could not mark notification job ${job.id} for retry`);
        }

        appendDebugLog(
            `WORKER SEND RETRY jobId=${job.id} messageId=${job.message_id} attempts=${job.attempts} retryAt=${retryAtTs} error=${errText}`
        );

        logger.warn(
            {
                jobId: job.id,
                messageId: job.message_id,
                attempts: job.attempts,
                retryAtTs,
                error: errText,
            },
            'Notification email send failed; scheduled for retry'
        );

        return {
            processed: true,
            status: 'retry',
            jobId: job.id,
            messageId: job.message_id,
            attempts: job.attempts,
            retryAtTs,
            error: errText,
        };
    }
}

async function processNextNotification(options = {}) {
    const logger = getLogger(options.logger);
    const effectiveOptions = applyConfigDefaults(options);
    await ensureConfigInitialized(effectiveOptions);
    await notificationDb.ensureSchema();

    const reclaimed = await notificationDb.reclaimExpiredLeases();
    if (reclaimed > 0) {
        appendDebugLog(`WORKER RECLAIM reclaimed=${reclaimed}`);
        logger.warn({ reclaimed }, 'Notification worker reclaimed expired leases');
    }

    const throttleState = await getThrottleState(effectiveOptions);
    if (throttleState.throttled) {
        appendDebugLog(
            `WORKER THROTTLED lastSentTs=${throttleState.lastSentTs} nextEligibleTs=${throttleState.nextEligibleTs}`
        );

        return {
            processed: false,
            status: 'throttled',
            reclaimed,
            nextEligibleTs: throttleState.nextEligibleTs,
            lastSentTs: throttleState.lastSentTs,
        };
    }

    const leaseMs = toPositiveInt(effectiveOptions.leaseMs, 60000);
    const job = await notificationDb.leaseNextPendingNotification({ leaseMs });

    if (!job) {
        return {
            processed: false,
            status: 'idle',
            reclaimed,
        };
    }

    appendDebugLog(
        `WORKER LEASED jobId=${job.id} messageId=${job.message_id} to=${job.recipient_email} attempts=${job.attempts} leaseUntil=${job.lease_until_ts}`
    );

    logger.info(
        {
            jobId: job.id,
            messageId: job.message_id,
            recipientUserId: job.recipient_user_id,
            attempts: job.attempts,
        },
        'Notification worker leased next job'
    );

    const transport = effectiveOptions.transport || createTransport(effectiveOptions);
    const result = await processLeasedJob(job, transport, effectiveOptions);
    result.reclaimed = reclaimed;
    return result;
}

async function processNotificationBatch(options = {}) {
    const initializedConfig = await ensureConfigInitialized(options);
    const effectiveOptions = applyConfigDefaults(Object.assign({}, options, { config: initializedConfig }));

    const maxJobs = toPositiveInt(effectiveOptions.maxJobs, 25);
    const transport = effectiveOptions.transport || createTransport(effectiveOptions);
    const summary = {
        processed: 0,
        sent: 0,
        retry: 0,
        failed: 0,
        idle: false,
        throttled: false,
        reclaimed: 0,
        results: [],
    };

    for (let i = 0; i < maxJobs; i += 1) {
        const result = await processNextNotification(
            Object.assign({}, effectiveOptions, {
                transport,
            })
        );

        summary.reclaimed += result.reclaimed || 0;

        if (!result.processed) {
            if ('throttled' === result.status) {
                summary.throttled = true;
                summary.nextEligibleTs = result.nextEligibleTs;

                if (false !== effectiveOptions.waitOnThrottle && result.nextEligibleTs) {
                    const waitMs = Math.max(0, new Date(result.nextEligibleTs).getTime() - Date.now());
                    appendDebugLog(
                        `WORKER WAIT throttleMs=${waitMs} nextEligibleTs=${result.nextEligibleTs}`
                    );
                    await sleep(waitMs);
                    continue;
                }
            } else {
                summary.idle = true;
            }
            break;
        }

        summary.processed += 1;
        summary.results.push(result);

        if ('sent' === result.status) {
            summary.sent += 1;
        } else if ('retry' === result.status) {
            summary.retry += 1;
        } else if ('failed' === result.status) {
            summary.failed += 1;
        }
    }

    return summary;
}

function createLockOwner() {
    return `mail-worker-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

function getRunLockMs(options = {}) {
    const workerConfig = getMailWorkerConfig(options);
    const configuredRunLockMs = options.runLockMs || workerConfig.runLockMs;
    if (configuredRunLockMs) {
        return toPositiveInt(configuredRunLockMs, 3600000);
    }

    const configuredRunLockSec = workerConfig.runLockSec;
    if (configuredRunLockSec) {
        return toPositiveInt(configuredRunLockSec, 3600) * 1000;
    }

    return 3600000;
}

function getPollIntervalMs(options = {}) {
    const workerConfig = getMailWorkerConfig(options);
    const pollSeconds = options.polltime || workerConfig.polltime;
    return toPositiveInt(pollSeconds, 300) * 1000;
}

function getPollGraceMs(options = {}) {
    const workerConfig = getMailWorkerConfig(options);
    const graceMs =
        options.pollGraceMs ||
        workerConfig.pollGraceMs ||
        (toPositiveInt(workerConfig.pollGraceSec, 0) * 1000);

    return toPositiveInt(graceMs, 1000);
}

async function shouldRunScheduledPoll(options = {}) {
    const pollIntervalMs = getPollIntervalMs(options);
    const pollGraceMs = getPollGraceMs(options);
    const state = await notificationDb.getStateValue(WORKER_LAST_POLL_TS_KEY);
    const lastPollTs = _.get(state, 'state_value', '');

    if (!lastPollTs) {
        return {
            due: true,
            pollIntervalMs,
            pollGraceMs,
            lastPollTs: null,
            nextEligibleTs: null,
        };
    }

    const elapsedMs = Date.now() - new Date(lastPollTs).getTime();
    if ((elapsedMs + pollGraceMs) >= pollIntervalMs) {
        return {
            due: true,
            pollIntervalMs,
            pollGraceMs,
            lastPollTs,
            nextEligibleTs: null,
        };
    }

    return {
        due: false,
        pollIntervalMs,
        pollGraceMs,
        lastPollTs,
        nextEligibleTs: isoAfterMs(lastPollTs, pollIntervalMs),
    };
}

function normalizeScheduledArgs(args) {
    if (_.isArray(args) && _.isPlainObject(args[0])) {
        return args[0];
    }

    if (_.isPlainObject(args)) {
        return args;
    }

    return {};
}

async function runScheduledPollMethod(args = {}, callback = _.noop) {
    const methodOptions = normalizeScheduledArgs(args);
    const logger = getLogger(methodOptions.logger);

    if (scheduledRunInProgress) {
        appendDebugLog('SCHED POLL SKIP reason=in_process');
        logger.info({ reason: 'in_process' }, 'Notification scheduled poll skipped');
        return callback(null, { skipped: true, reason: 'in_process' });
    }

    scheduledRunInProgress = true;
    let lockOwner;
    let lockAcquired = false;

    try {
        const config = await ensureConfigInitialized(methodOptions);
        const options = applyConfigDefaults(Object.assign({}, methodOptions, { config }));

        await notificationDb.ensureSchema();

        const dueState = await shouldRunScheduledPoll(options);
        if (!dueState.due) {
            appendDebugLog(
                `SCHED POLL SKIP reason=not_due nextEligibleTs=${dueState.nextEligibleTs}`
            );
            logger.info(
                {
                    reason: 'not_due',
                    nextEligibleTs: dueState.nextEligibleTs,
                },
                'Notification scheduled poll skipped'
            );
            return callback(null, {
                skipped: true,
                reason: 'not_due',
                nextEligibleTs: dueState.nextEligibleTs,
            });
        }

        lockOwner = createLockOwner();
        const lockResult = await notificationDb.acquireStateLease(WORKER_RUN_LOCK_KEY, {
            owner: lockOwner,
            leaseMs: getRunLockMs(options),
            meta: {
                pid: process.pid,
                source: 'eventScheduler',
            },
        });

        if (!lockResult.acquired) {
            appendDebugLog('SCHED POLL SKIP reason=lock_busy');
            logger.info({ reason: 'lock_busy' }, 'Notification scheduled poll skipped');
            return callback(null, {
                skipped: true,
                reason: 'lock_busy',
            });
        }

        lockAcquired = true;
        await notificationDb.setStateValue(WORKER_LAST_POLL_TS_KEY, nowIso());

        appendDebugLog('SCHED POLL START');
        logger.info('Notification scheduled poll started');

        const summary = await processNotificationBatch(
            Object.assign({}, options, {
                waitOnThrottle: true,
            })
        );

        appendDebugLog(
            `SCHED POLL END processed=${summary.processed} sent=${summary.sent} retry=${summary.retry} failed=${summary.failed} idle=${summary.idle} throttled=${summary.throttled}`
        );
        logger.info({ summary }, 'Notification scheduled poll finished');

        return callback(null, summary);
    } catch (err) {
        const errText = serializeError(err);
        appendDebugLog(`SCHED POLL ERROR error=${errText}`);
        logger.error({ error: errText }, 'Notification scheduled poll failed');
        return callback(err);
    } finally {
        if (lockAcquired && lockOwner) {
            try {
                await notificationDb.releaseStateLease(WORKER_RUN_LOCK_KEY, lockOwner);
            } catch (releaseErr) {
                appendDebugLog(
                    `SCHED POLL RELEASE WARN error=${serializeError(releaseErr)}`
                );
            }
        }
        scheduledRunInProgress = false;
    }
}

module.exports = {
    WORKER_RUN_LOCK_KEY,
    WORKER_LAST_POLL_TS_KEY,
    calculateRetryDelayMs,
    ensureConfigInitialized,
    createTransport,
    buildMailPayload,
    getThrottleState,
    getPollGraceMs,
    sendMailForJob,
    processLeasedJob,
    processNextNotification,
    processNotificationBatch,
    shouldRunScheduledPoll,
    scheduledPollRun: runScheduledPollMethod,
};

if (require.main === module) {
    processNotificationBatch({
        logger: console,
        maxJobs: process.env.ENIGMA_NOTIFICATION_MAX_JOBS,
        leaseMs: process.env.ENIGMA_NOTIFICATION_LEASE_MS,
        maxAttempts: process.env.ENIGMA_NOTIFICATION_MAX_ATTEMPTS,
        retryBaseMs: process.env.ENIGMA_NOTIFICATION_RETRY_BASE_MS,
        retryMaxMs: process.env.ENIGMA_NOTIFICATION_RETRY_MAX_MS,
        minSendIntervalMs: process.env.ENIGMA_NOTIFICATION_MIN_SEND_INTERVAL_MS,
        waitOnThrottle: '0' !== process.env.ENIGMA_NOTIFICATION_WAIT_ON_THROTTLE,
        runLockMs: process.env.ENIGMA_NOTIFICATION_RUN_LOCK_MS,
        polltime: process.env.ENIGMA_NOTIFICATION_POLLTIME,
    })
        .then(summary => {
            console.log(JSON.stringify(summary, null, 2));
            process.exitCode = 0;
        })
        .catch(err => {
            console.error(err && err.stack ? err.stack : err);
            process.exitCode = 1;
        });
}

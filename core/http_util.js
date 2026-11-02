const { Errors, ErrorReasons } = require('./enig_error.js');
const Security = require('./activitypub/security.js');
const FetchBudget = require('./activitypub/fetch_budget.js');
const { isSafeOutboundUrl } = Security;
//  read through the module each time: tests swap config.get and the logger
const Config = () => require('./config').get();
const Log = () => require('./logger.js').log;

// deps
const { isString, isObject, truncate } = require('lodash');
const httpsNoRedirects = require('node:https');
const httpNoRedirects = require('node:http');
const {
    https: httpsWithRedirects,
    http: httpWithRedirects,
} = require('follow-redirects');
const httpSignature = require('http-signature');
const crypto = require('crypto');
const dns = require('node:dns');

const DefaultTimeoutMilliseconds = 5000;

//  |timeout| is an idle timeout: a host trickling a byte at a time never
//  trips it. Every request is also cut off after this long overall: twice
//  its timeout, and at least MinDeadlineMilliseconds.
const MinDeadlineMilliseconds = 30000;
let minDeadlineMs = MinDeadlineMilliseconds;

//  follow-redirects allows 21 by default; each hop is another host to ask
const MaxRedirects = 3;

exports.getJson = getJson;
exports.postJson = postJson;
exports.allowInsecureHttp = () => _allowHttp();
exports._checkedLookup = _checkedLookup; // exported for tests
exports._redirectUrl = _redirectUrl; // exported for tests

//
//  SSRF protection at connect time (#966). isSafeOutboundUrl() only sees the
//  name in a URL; a public name can resolve to a private address, or resolve
//  differently a moment later (DNS rebinding). Every outbound socket is
//  therefore made by one of these agents, whose lookup resolves the host and
//  refuses the connection if ANY of its addresses is blocked.
//
//  They are dedicated rather than the global agents: a reused keep-alive
//  socket skips lookup, so the pool must only ever hold sockets that were
//  checked here.
//
//  https:// is always checked. http:// is only possible with
//  allowInsecureHttp, which is an "I know what I'm doing" override for local
//  dev/test, so the HTTP agent skips the check while it is set (read per
//  lookup: config hot-reloads).
//
const AgentOptions = { keepAlive: true, scheduling: 'lifo', timeout: 5000 };
const httpsAgent = new httpsNoRedirects.Agent(
    Object.assign({}, AgentOptions, {
        lookup: (hostname, opts, cb) => _checkedLookup(true, hostname, opts, cb),
    })
);
const httpAgent = new httpNoRedirects.Agent(
    Object.assign({}, AgentOptions, {
        lookup: (hostname, opts, cb) => _checkedLookup(false, hostname, opts, cb),
    })
);
exports._agents = { http: httpAgent, https: httpsAgent }; // exported for tests
//  for tests: a shorter overall deadline floor (null restores it)
exports._setMinDeadlineMs = ms => {
    minDeadlineMs = ms || MinDeadlineMilliseconds;
};

//
//  A net/tls lookup function. |strict| is false only for the HTTP agent,
//  which honours allowInsecureHttp. Node may ask for one address
//  (cb(err, address, family)) or all of them (opts.all: cb(err, [{address,
//  family}])); every address is resolved and checked either way.
//
function _checkedLookup(strict, hostname, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    } else if (typeof opts === 'number') {
        opts = { family: opts };
    }

    if (!strict && _allowHttp()) {
        return dns.lookup(hostname, opts, cb);
    }

    dns.lookup(hostname, Object.assign({}, opts, { all: true }), (err, addresses) => {
        if (err) {
            return cb(err);
        }

        const refused = addresses
            .map(a => ({
                address: a.address,
                reason: Security.isBlockedAddress(a.address),
            }))
            .filter(r => r.reason);
        if (refused.length > 0) {
            //  not |hostname|: that is bunyan's field for this machine's name
            Log().warn(
                { host: hostname, refused },
                'Outbound connection refused: host resolves to a blocked address'
            );
            //  no addresses in the error: it may find its way back to a remote
            return cb(
                Errors.AccessDenied(
                    `Outbound connection to "${hostname}" refused: it resolves to a blocked address`,
                    ErrorReasons.BlockedAddress
                )
            );
        }

        if (opts.all) {
            return cb(null, addresses);
        }
        return cb(null, addresses[0].address, addresses[0].family);
    });
}

function getJson(url, options, cb) {
    options = Object.assign({}, { method: 'GET' }, options);

    return _makeRequest(url, options, (err, body, res) => {
        if (err) {
            return cb(err);
        }

        if (Array.isArray(options.validContentTypes)) {
            const contentType = res.headers['content-type'] || '';
            if (
                !options.validContentTypes.some(ct => {
                    return contentType.startsWith(ct);
                })
            ) {
                return cb(Errors.HttpError(`Invalid Content-Type: ${contentType}`));
            }
        }

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            return cb(e);
        }

        return cb(null, parsed, res);
    });
}

function postJson(url, json, options, cb) {
    if (!isString(json)) {
        json = JSON.stringify(json);
    }

    options = Object.assign({}, { method: 'POST', body: json }, options);
    if (
        !options.headers ||
        !Object.keys(options.headers).find(h => h.toLowerCase() === 'content-type')
    ) {
        options.headers['Content-Type'] = 'application/json';
    }

    return _makeRequest(url, options, cb);
}

function _allowHttp() {
    try {
        return (
            Config().contentServers.web.handlers.activityPub.allowInsecureHttp === true
        );
    } catch {
        return false;
    }
}

function _maxResponseBodyBytes() {
    try {
        return (
            Config().contentServers.web.handlers.activityPub.maxResponseBodyBytes ||
            524288 // 512 KiB default
        );
    } catch {
        return 524288;
    }
}

//
//  The URL of the hop follow-redirects is about to request, from the options
//  it built for it: an IPv6 hostname comes without its brackets, and the
//  port (empty or null for the protocol's default) separately.
//
function _redirectUrl(reqOptions) {
    const { protocol, hostname, port, path } = reqOptions;
    const host = hostname.includes(':') ? `[${hostname}]` : hostname;
    return `${protocol}//${host}${port ? `:${port}` : ''}${path}`;
}

function _makeRequest(url, options, cb) {
    options = Object.assign({}, { timeout: DefaultTimeoutMilliseconds }, options);

    //  SSRF protection: reject private/loopback/reserved URLs before connecting.
    const ssrfReason = isSafeOutboundUrl(url, _allowHttp());
    if (ssrfReason) {
        return cb(Errors.AccessDenied(`Outbound request blocked: ${ssrfReason}`));
    }

    //  Ensure headers object exists and always send a User-Agent.
    //  Some servers (e.g. GoToSocial) reject requests without one.
    if (!options.headers) {
        options.headers = {};
    }
    if (!options.headers['User-Agent']) {
        options.headers['User-Agent'] =
            'ENiGMA-BBS/ActivityPub (+https://enigma-bbs.github.io)';
    }

    if (options.body) {
        options.headers['Content-Length'] = Buffer.from(options.body).length;

        if (options?.sign?.headers?.includes('digest')) {
            options.headers['Digest'] =
                'SHA-256=' +
                crypto.createHash('sha256').update(options.body).digest('base64');
        }
    }

    //  A GET made while handling an inbox POST is budgeted (#966): see
    //  activitypub/fetch_budget.js. Outside one this admits everything.
    //  POSTs (deliveries, Accept, ...) are never budgeted.
    let release = () => {};
    if (options.method === 'GET') {
        const slot = FetchBudget.acquire(url);
        if (slot.error) {
            return cb(slot.error);
        }
        release = slot.release;
    }

    let cbCalled = false;
    let deadline;
    const cbWrapper = (e, b, r) => {
        if (!cbCalled) {
            cbCalled = true;
            clearTimeout(deadline);
            release();
            return cb(e, b, r);
        }
    };

    const isHttp = /^http:\/\//i.test(url);
    let httpLib;
    if (options.method === 'POST' || options.sign) {
        httpLib = isHttp ? httpNoRedirects : httpsNoRedirects;
        //  always ours, even over a caller's: see the agents above
        options.agent = isHttp ? httpAgent : httpsAgent;
    } else {
        //  For unsigned GETs we use follow-redirects, but we must check each
        //  redirect target for SSRF before following it.
        const redirectOpts = {
            beforeRedirect(reqOptions) {
                const redirectUrl = _redirectUrl(reqOptions);
                const reason = isSafeOutboundUrl(redirectUrl, _allowHttp());
                if (reason) {
                    throw new Error(`Redirect blocked: ${reason}`);
                }
                //  each hop of an inbox-triggered GET costs its host a rate
                //  token and the POST a fetch (see fetch_budget.js)
                const budgetErr = FetchBudget.chargeRedirect(redirectUrl);
                if (budgetErr) {
                    throw budgetErr;
                }
            },
        };
        options = Object.assign({}, redirectOpts, options);
        options.maxRedirects = MaxRedirects;
        //  follow-redirects picks the agent per hop by protocol
        options.agents = { http: httpAgent, https: httpsAgent };
        delete options.agent;
        httpLib = isHttp ? httpWithRedirects : httpsWithRedirects;
    }

    let req;
    let responded = false;
    try {
        req = httpLib.request(url, options, res => {
            responded = true;
            const maxBytes = _maxResponseBodyBytes();
            let body = [];
            let totalBytes = 0;

            res.on('data', d => {
                totalBytes += d.length;
                if (totalBytes > maxBytes) {
                    res.destroy();
                    return cbWrapper(
                        Errors.HttpError(
                            `Response from ${url} exceeds ${maxBytes} byte limit`
                        )
                    );
                }
                body.push(d);
            });

            res.on('end', () => {
                body = Buffer.concat(body).toString();

                if (res.statusCode < 200 || res.statusCode > 299) {
                    const err = Errors.HttpError(
                        `URL ${url} HTTP error ${res.statusCode}: ${truncate(body, {
                            length: 128,
                        })}`
                    );
                    //  callers may need to know why, and who answered
                    err.statusCode = res.statusCode;
                    err.responseUrl = res.responseUrl || url;
                    return cbWrapper(err);
                }

                return cbWrapper(null, body, res);
            });

            //  a response cut off part way (the socket closed, or was
            //  destroyed) ends with neither 'end' nor a request 'error'
            res.on('error', err => cbWrapper(err));
            res.on('close', () => {
                if (!res.complete) {
                    return cbWrapper(
                        Errors.HttpError(`Response from ${url} was cut off`)
                    );
                }
            });
        });
    } catch (e) {
        return cbWrapper(e);
    }

    if (isObject(options.sign)) {
        try {
            httpSignature.sign(req, options.sign);
        } catch (e) {
            req.destroy(Errors.Invalid(`Invalid signing material: ${e}`));
        }
    }

    req.on('error', err => {
        //  follow-redirects wraps what beforeRedirect throws
        if (err && err.cause && FetchBudget.isBudgetError(err.cause)) {
            err = err.cause;
        }
        return cbWrapper(err);
    });

    //  closed with no response and no error: nothing else will call back
    req.on('close', () => {
        if (!responded) {
            return cbWrapper(Errors.HttpError(`Connection for ${url} closed`));
        }
    });

    //  the error given first, as destroying may also report a cut-off
    const giveUp = err => {
        cbWrapper(err);
        req.destroy(err);
    };

    req.on('timeout', () => {
        giveUp(Errors.Timeout('Timeout making HTTP request'));
    });

    deadline = setTimeout(
        () => giveUp(Errors.Timeout(`HTTP request to ${url} took too long`)),
        Math.max(options.timeout * 2, minDeadlineMs)
    );
    if (deadline.unref) {
        deadline.unref();
    }

    if (options.body) {
        req.write(options.body);
    }
    req.end();
}

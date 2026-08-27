/* jslint node: true */
'use strict';

//  ENiGMA½
const { EnigError, ErrorCodes } = require('./enig_error.js');
const logger = require('./logger.js');

exports.listenServer = listenServer;
exports.makeBindError = makeBindError;
exports.reportListening = reportListening;
exports.reportBindFailure = reportBindFailure;
exports.formatBindTarget = formatBindTarget;
exports.consoleStyle = consoleStyle;

const ANSI_RESET = '\u001b[0m';

//  Width of the server name column in startup output. Long enough for
//  'websocket' and 'gopher' to line up without wrapping a narrow terminal.
const NAME_COLUMN_WIDTH = 10;

//
//  Human readable description of what we tried to bind.
//
//  |address| is frequently undefined: none of the login or content servers
//  define an address default (only BinkP does), and Node treats a missing
//  host as "every interface". Render that as '*' rather than 'undefined'.
//
function formatBindTarget(address, port) {
    return `${address || '*'}:${port}`;
}

//
//  Turn a bind failure into an EnigError carrying a message an operator can
//  act on. The raw Node errors ('listen EADDRINUSE: address already in use
//  0.0.0.0:8888') do not say which ENiGMA½ server failed, and EACCES in
//  particular gives no hint as to why.
//
function makeBindError(err, { name, port, address }) {
    const target = formatBindTarget(address, port);

    let reason;
    switch (err.code) {
        case 'EADDRINUSE':
            reason =
                `${target} is already in use - is another ENiGMA½ instance ` +
                'or another service already running?';
            break;

        case 'EACCES':
            reason =
                `permission denied binding ${target} - ports below 1024 require ` +
                'elevated privileges or CAP_NET_BIND_SERVICE';
            break;

        case 'EADDRNOTAVAIL':
            reason =
                `${target} is not available on this host - check the configured ` +
                'address';
            break;

        default:
            reason = `${target}: ${err.message}`;
            break;
    }

    const bindErr = new EnigError(
        `${name} server could not bind`,
        ErrorCodes.UnexpectedState,
        reason,
        err.code
    );

    //  So callers can special case, and so bbs.js knows this has already been
    //  presented to the operator and should not be dumped a second time.
    bindErr.bindFailure = true;
    bindErr.consoleReported = false;
    return bindErr;
}

//
//  Colour for the console, but only when it will actually help: a TTY, and
//  NO_COLOR unset (https://no-color.org/). Anything redirected to a file, a
//  pipe, or a systemd journal gets clean text.
//
//  Input is pipe/Renegade coded so it matches the rest of the codebase rather
//  than introducing a second colour vocabulary.
//
function consoleStyle(s, stream) {
    stream = stream || process.stdout;

    //  Required at call time, not module load: color_codes.js reaches back
    //  here through predefined_mci -> message_area -> activitypub -> web.js,
    //  and destructuring at load time in that cycle yields undefined.
    const { renegadeToAnsi, stripMciColorCodes } = require('./color_codes.js');

    const useColor = !('NO_COLOR' in process.env) && true === stream.isTTY;
    if (!useColor) {
        return stripMciColorCodes(s);
    }

    return `${renegadeToAnsi(s)}${ANSI_RESET}`;
}

function nameColumn(name) {
    return name.padEnd(NAME_COLUMN_WIDTH);
}

function reportListening({ name, port, address }) {
    const target = formatBindTarget(address, port);
    console.info(consoleStyle(`  |10${nameColumn(name)}|07listening on |15${target}`));
}

function reportBindFailure(bindErr, { name }) {
    console.error(
        consoleStyle(
            `  |12${nameColumn(name)}FAILED: |15${bindErr.reason}`,
            process.stderr
        )
    );
    bindErr.consoleReported = true;
}

//
//  Bind |server| and call back exactly once.
//
//  Node's server.listen(port, host, cb) registers |cb| as a one-shot
//  'listening' listener: it never receives an error argument, and on a failed
//  bind it never fires at all. Every ENiGMA½ server used it as though it were
//  an error-first callback, so a port conflict left the startup waterfall in
//  core/listening_server.js waiting forever — no message, no exit, and no
//  'System started!'. See issue #547.
//
//  Listening for both 'listening' and 'error' is the only way to get a
//  definitive answer. A pre-flight "is the port free?" probe cannot do it:
//  connecting to a port answers a different question than binding one, and
//  anything learned before the bind is already stale by the time it happens.
//
function listenServer(server, options, cb) {
    const { port, address, name, log } = options;

    let settled = false;

    const finish = err => {
        if (settled) {
            return;
        }
        settled = true;

        server.removeListener('listening', onListening);
        server.removeListener('error', onError);

        if (!err) {
            //  Now that the bind has succeeded, keep a persistent handler so a
            //  later socket-level error (EMFILE and friends) is logged rather
            //  than thrown as an unhandled 'error' event.
            server.on('error', runtimeErr => {
                (log || logger.log).warn(
                    { server: name, error: runtimeErr.message },
                    'Server error'
                );
            });

            reportListening(options);
        } else {
            reportBindFailure(err, options);
        }

        return cb(err);
    };

    const onListening = () => finish(null);
    const onError = err => finish(makeBindError(err, options));

    server.on('listening', onListening);
    server.on('error', onError);

    try {
        server.listen(port, address);
    } catch (e) {
        //  Node throws synchronously for a malformed address/port rather than
        //  emitting 'error'.
        return finish(makeBindError(e, options));
    }
}

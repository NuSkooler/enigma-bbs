'use strict';

//
//  The WFC dashboard (form 0) as luciano_blocktronics lays it out -- node
//  list, quick log, status bar and the custom views 11-25, at the positions
//  and with the formats the theme gives them -- over a real ClientTerminal
//  whose socket writes are captured. A few fake nodes are connected.
//
//  |requireCore| loads a module from core/, so the same dashboard can be
//  built from another checkout (the before numbers in WP3 PR B came from
//  origin/master this way).
//

const { EventEmitter } = require('events');
const bunyan = require('bunyan');

const defaultRequireCore = name => require(`../../core/${name}`);

const quietLog = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
        return quietLog;
    },
};

//  luciano_blocktronics theme.hjson, mainMenuWaitingForCaller
const THEME_CONFIG = {
    quickLogTimestampFormat: '|01|03MM|08/|03DD hh:mm:ssa',
    nowDateTimeFormat: '|00|10ddd MMM Do|08, |10h|08:|10mm|02a',
    lastLoginDateTimeFormat: '|00|10ddd hh|08:|10mm|02a',
    statusBarNowFormat: '{now}',
    statusBarUserFormat: '|00|10{currentUserName}',
    statusBarMailFormat:
        '|00|02Prv|08:|10{newPrivateMail} |02Addr|08:|10{newMessagesAddrTo}',
    statusBarStatusFormat: '|00|02Avl|08:|10{availIndicator} |02Vis|08:|10{visIndicator}',
    statusBarMessagesFormat: '|00|02Msg|08:|02{count}',
    statusBarMessagesActiveFormat: '|00|14Msg|08:|15{count}',
    statusBarPagesFormat: '|00|02Page|08:|02{count}',
    statusBarPagesActiveFormat: '|00|13Page|08:|15{count}',
    mainInfoFormat11: '|00|15{callsToday:>5}',
    mainInfoFormat12: '|00|15{postsToday:>5}',
    mainInfoFormat13: '|00|15{newUsersToday:>5}',
    mainInfoFormat14: '|00|15{uploadsToday:<4}',
    mainInfoFormat15: '|00|15{downloadsToday:<4}',
    mainInfoFormat16:
        '|00|15{uploadBytesToday!sizeWithoutAbbr:<5} |07{uploadBytesToday!sizeAbbr}',
    mainInfoFormat17:
        '|00|15{downloadBytesToday!sizeWithoutAbbr:<5} |07{downloadBytesToday!sizeAbbr}',
    mainInfoFormat18: '|00|15{lastLoginUserName:<26} |07{lastLogin}',
    mainInfoFormat20:
        '|00|15{freeMemoryBytes!sizeWithoutAbbr} |07{freeMemoryBytes!sizeAbbr} free |08/ |15{totalMemoryBytes!sizeWithoutAbbr} |07{totalMemoryBytes!sizeAbbr}',
    mainInfoFormat22:
        '|00|15{systemCurrentLoad} |07% |08/ |15{systemAvgLoad} |07load avg|08.',
    mainInfoFormat24:
        '|00|15{processUptimeSeconds!durationSeconds} |08/ |15{processBytesIngress!sizeWithoutAbbr:>4} |07{processBytesIngress!sizeAbbr}|08/|15{processBytesEgress!sizeWithoutAbbr:>4} |07{processBytesEgress!sizeAbbr}',
    mainInfoFormat19: '|00|15{totalCalls:>5}',
    mainInfoFormat21: '|00|15{totalPosts:>7}',
    mainInfoFormat23: '|00|15{totalUsers:>5}',
    mainInfoFormat25:
        '|00|15{totalFiles:>4} |08/ |15{totalFileBytes!sizeWithoutAbbr:>4} |07{totalFileBytes!sizeAbbr}',
    quickLogLevelIndicators: {
        trace: '|00|02T',
        debug: '|00|03D',
        info: '|00|15I',
        warn: '|00|14W',
        error: '|00|12E',
        fatal: '|00|28F',
    },
    quickLogLevelMessagePrefixes: {
        trace: '|00|02',
        debug: '|00|03',
        info: '|00|07',
        warn: '|00|14',
        error: '|00|12',
        fatal: '|00|28',
    },
    statusAvailableIndicators: ['N', 'Y'],
    statusVisibleIndicators: ['N', 'Y'],
    nodeStatusSelectionFormat:
        '|00|07{realName:<12}\n|08- |07{serverName:<10}\n|08- |07{remoteAddress:<10}\n{pageIndicator}',
    pageIndicator: '|13!',
};

//  wfc.ans: MCI positions (row, col)
const CUSTOM_VIEW_POSITIONS = {
    11: [4, 74],
    12: [5, 74],
    13: [6, 74],
    14: [9, 59],
    15: [9, 69],
    16: [10, 59],
    17: [10, 69],
    18: [10, 4],
    19: [13, 74],
    20: [13, 11],
    21: [14, 72],
    22: [14, 11],
    23: [15, 74],
    24: [15, 11],
    25: [16, 67],
};
const CUSTOM_VIEW_WIDTHS = { 20: 30, 22: 30, 24: 30 };

function captureSession(ClientTerminal) {
    const writes = [];
    const output = {
        writable: true,
        write(data, cb) {
            writes.push(
                'string' === typeof data ? Buffer.from(data, 'latin1') : Buffer.from(data)
            );
            if (cb) {
                cb(null);
            }
        },
    };
    const term = new ClientTerminal(output);
    term.outputEncoding = 'cp437';
    term.termWidth = 80;
    term.termHeight = 25;
    return { term, writes };
}

//  A connection as client_connections.getActiveConnectionList() reads one
function fakeConnection(node, userName, { lastLoginTs, desc = 'Main Menu' } = {}) {
    return {
        node,
        session: { id: 1000 + node, serverName: 'SSH', isSecure: true },
        friendlyRemoteAddress: () => `10.0.0.${node}`,
        currentMenuModule: { menuConfig: { desc } },
        user: {
            userId: node,
            username: userName,
            properties: { last_login_timestamp: lastLoginTs },
            isAuthenticated: () => true,
            isVisible: () => true,
            isAvailable: () => true,
            realName: () => `${userName} Real`,
            getProperty: () => undefined,
        },
    };
}

function buildDashboard({ requireCore = defaultRequireCore, nodes = 3 } = {}) {
    const { ClientTerminal } = requireCore('client_term.js');
    const { TextView } = requireCore('text_view.js');
    const { VerticalMenuView } = requireCore('vertical_menu_view.js');
    const { StatusBarView } = requireCore('status_bar_view.js');
    const { clientConnections } = requireCore('client_connections.js');
    const WfcModule = requireCore('wfc.js').getModule;

    const { term, writes } = captureSession(ClientTerminal);

    const client = new EventEmitter();
    client.node = 1;
    client.term = term;
    client.log = quietLog;
    client.user = {
        username: 'Sysop',
        properties: {},
        setVisibility: () => {},
        isVisible: () => true,
        isAvailable: () => true,
        realName: () => 'Sysop Real',
        isAuthenticated: () => true,
    };
    client.currentTheme = {
        helpers: {
            getDateFormat: () => 'YYYY-MM-DD',
            getTimeFormat: () => 'HH:mm',
            getDateTimeFormat: () => 'YYYY-MM-DD HH:mm',
        },
    };
    client.startIdleMonitor = () => {};
    client.stopIdleMonitor = () => {};

    const wfc = new WfcModule({
        menuName: 'mainMenuWaitingForCaller',
        menuConfig: {
            config: Object.assign({ acs: 'SCID1', art: {} }, THEME_CONFIG),
        },
        client,
    });

    //  Stats as _refreshStats() builds them, minus the database. Each tick
    //  moves process uptime on by five seconds, as on a live board.
    let uptime = 3600;
    const lastLogin = new Date('2026-11-14T10:00:00Z');
    wfc._refreshStats = cb => {
        wfc.stats = {
            boardName: 'Test Board',
            now: 'Sat Nov 14th, 10:15a',
            processUptimeSeconds: uptime,
            totalCalls: 1234,
            totalPosts: 5678,
            totalUsers: 42,
            totalFiles: 900,
            totalFileBytes: 123456789,
            callsToday: 7,
            postsToday: 3,
            uploadsToday: 1,
            uploadBytesToday: 2048,
            downloadsToday: 2,
            downloadBytesToday: 4096,
            newUsersToday: 0,
            currentUserName: 'Sysop',
            currentUserRealName: 'Sysop Real',
            availIndicator: 'Y',
            visIndicator: 'Y',
            lastLoginUserName: 'Bob',
            lastLogin: 'Sat 10:00a',
            totalMemoryBytes: 8 * 1024 * 1024 * 1024,
            freeMemoryBytes: 3 * 1024 * 1024 * 1024,
            systemAvgLoad: 0.5,
            systemCurrentLoad: 1,
            newPrivateMail: 0,
            newMessagesAddrTo: 0,
            processBytesIngress: 1024 * 1024,
            processBytesEgress: 4 * 1024 * 1024,
            pendingPageCount: 0,
            pendingNodeMessageCount: 0,
        };
        wfc._updateStatusBarPanels();
        return cb(null);
    };
    const advance = (seconds = 5) => {
        uptime += seconds;
    };

    //  form 0, built as the view controller would from wfc.ans
    let views;
    const buildViews = () => {
        views = {
            1: new VerticalMenuView({
                client,
                id: 1,
                position: { row: 4, col: 4 },
                dimens: { width: 37, height: 5 },
                acceptsFocus: true,
            }),
            2: new VerticalMenuView({
                client,
                id: 2,
                position: { row: 19, col: 4 },
                dimens: { width: 73, height: 5 },
            }),
            5: new StatusBarView({
                client,
                id: 5,
                position: { row: 1, col: 2 },
                dimens: { width: 78 },
                separator: ' ',
                panels: [
                    { name: 'now', width: 21 },
                    { name: 'user', width: 'fill' },
                    { name: 'mail', width: 14 },
                    { name: 'status', width: 11 },
                    { name: 'messages', width: 7 },
                    { name: 'pages', width: 7 },
                ],
            }),
        };
        views[1].setPropertyValue(
            'itemFormat',
            '|00  |15{node:<3.2} {pageIndicator}|11{userName:<12} |07{action:<14.13} |15{serverName}'
        );
        views[1].setPropertyValue(
            'focusItemFormat',
            '|00|10> |15{node:<3.2} {pageIndicator}|11{userName:<12} |07{action:<14.13} |15{serverName}'
        );
        views[1].focusItemAtTop = false;
        //  set after construction, as the MCI config does it
        views[2].acceptsFocus = false;
        views[2].acceptsInput = false;
        views[2].setPropertyValue(
            'itemFormat',
            '|00|07{nodeId} {levelIndicator} |02{timestamp} {message:<51.50}'
        );
        Object.keys(CUSTOM_VIEW_POSITIONS).forEach(id => {
            const [row, col] = CUSTOM_VIEW_POSITIONS[id];
            views[id] = new TextView({
                client,
                id: parseInt(id, 10),
                position: { row, col },
                dimens: { width: CUSTOM_VIEW_WIDTHS[id] || 6 },
            });
        });
        views[1].setFocus(true);
        //  the view controller draws every view once the art is up
        Object.keys(views).forEach(id => views[id].redraw());

        wfc.viewControllers.main = {
            getView: id => views[id],
            getFocusedView: () => views[1],
            detachClientEvents: () => {},
        };
    };
    buildViews();

    //  the quick log's ring buffer, filled with a few records
    wfc.logRingBuffer = new bunyan.RingBuffer({ limit: 5 });
    const logAt = new Date('2026-11-14T10:00:00Z').getTime();
    let logSeq = 0;
    const addLog = (msg = `log line ${logSeq}`) => {
        wfc.logRingBuffer.write({
            time: new Date(logAt + 1000 * logSeq++),
            level: 30,
            msg,
            nodeId: 1,
        });
    };
    for (let i = 0; i < 5; ++i) {
        addLog();
    }

    //  connected nodes: ours, plus |nodes - 1| callers
    const added = [];
    const connect = (node, name, opts) => {
        const conn = fakeConnection(node, name, opts);
        clientConnections.push(conn);
        added.push(conn);
        return conn;
    };
    const lastLoginTs = lastLogin.toISOString();
    connect(1, 'Sysop', { lastLoginTs, desc: '-WFC-' });
    ['Alice', 'Bob', 'Carol', 'Dave'].slice(0, nodes - 1).forEach((name, i) => {
        connect(i + 2, name, { lastLoginTs });
    });
    const disconnect = conn => {
        const i = clientConnections.indexOf(conn);
        if (i > -1) {
            clientConnections.splice(i, 1);
        }
    };
    const cleanup = () => {
        added.forEach(disconnect);
    };

    //  The view controller rebuilding form 0 after _releaseMainForm()
    const redisplay = () => {
        wfc._releaseMainForm();
        buildViews();
    };

    const tick = () => {
        const before = writes.length;
        const beforeBytes = writes.reduce((n, b) => n + b.length, 0);
        wfc._refreshAll();
        const after = writes.reduce((n, b) => n + b.length, 0);
        return {
            writes: writes.length - before,
            bytes: after - beforeBytes,
            wire: Buffer.concat(writes.slice(before)),
        };
    };

    return {
        wfc,
        client,
        term,
        writes,
        views: () => views,
        connections: added,
        connect,
        disconnect,
        cleanup,
        redisplay,
        tick,
        advance,
        addLog,
    };
}

module.exports = { buildDashboard, captureSession, THEME_CONFIG };

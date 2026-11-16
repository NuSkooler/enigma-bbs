/* eslint-disable no-control-regex */
'use strict';

//
//  The WFC dashboard's five-second refresh draws only what changed (WP3 PR B):
//  the node list when what it shows (or its selection) changes, the quick log
//  when there is a new record (without blanking its rows first), and custom
//  views 10+ whose text changed. The task screen's custom views likewise, but
//  all of them after a prompt or result line was written over the screen.
//

const { strict: assert } = require('assert');

const { buildDashboard } = require('./helpers/wfc_dashboard_harness.js');
const { VirtualScreen } = require('./helpers/virtual_screen.js');
const { TextView } = require('../core/text_view.js');

//  How many times each row was moved to (CSI row;col H)
function gotoCounts(wire) {
    const counts = {};
    String(wire).replace(/\x1b\[(\d+);(\d+)H/g, (m, row) => {
        counts[row] = (counts[row] || 0) + 1;
        return m;
    });
    return counts;
}

function rowsDrawn(wire) {
    return Object.keys(gotoCounts(wire))
        .map(r => parseInt(r, 10))
        .sort((a, b) => a - b);
}

//  View.redraw() moves to the view's first row before the items do, so that
//  row is always moved to once more
function assertRowPasses(counts, rows, passes) {
    rows.forEach((r, i) => {
        assert.equal(counts[r], passes + (0 === i ? 1 : 0), `row ${r}`);
    });
}

const CONFIRM_XY = 4; //  wfc.js MciViewIds.main.confirmXy
const STATUS_BAR_ROW = 1;
const NODE_ROWS = [4, 5, 6, 7, 8];
const LOG_ROWS = [19, 20, 21, 22, 23];

describe('WFC refresh paints only what changed', () => {
    let dash;
    const sid = i => dash.connections[i].session.uniqueId;

    beforeEach(() => {
        dash = buildDashboard({ nodes: 3 });
        dash.tick(); //  first paint
    });

    afterEach(() => {
        dash.cleanup();
    });

    describe('idle tick', () => {
        it('draws nothing but the status bar when nothing changed', () => {
            const t = dash.tick();
            assert.equal(t.writes, 1);
            //  the status bar's panels are set (and drawn) every tick
            assert.deepEqual(rowsDrawn(t.wire.toString('latin1')), [STATUS_BAR_ROW]);
        });
    });

    describe('node list', () => {
        it('does not repaint for a field no format shows', () => {
            const before = dash.views()[1].getItem(1).remoteAddress;
            //  timeOnMinutes moves every tick on a live board; the remote
            //  address is not in itemFormat either
            dash.connections[1].friendlyRemoteAddress = () => '192.0.2.99';
            dash.connections[1].user.properties.last_login_timestamp = new Date(
                Date.now() - 90 * 1000
            ).toISOString();

            const t = dash.tick();
            const rows = rowsDrawn(t.wire.toString('latin1'));
            NODE_ROWS.forEach(r => assert.ok(!rows.includes(r), `row ${r} drawn`));

            //  ...but the list's items carry the fresh values for kick/chat
            const item = dash.views()[1].getItem(1);
            assert.notEqual(before, '192.0.2.99');
            assert.equal(item.remoteAddress, '192.0.2.99');
        });

        it('repaints when a shown field changes, without blanking the rows first', () => {
            dash.connections[2].currentMenuModule.menuConfig.desc = 'File Base';
            const t = dash.tick();
            const counts = gotoCounts(t.wire.toString('latin1'));

            //  three nodes on three rows, the two spare rows blanked once
            assertRowPasses(counts, NODE_ROWS, 1);
            assert.ok(t.wire.toString('latin1').includes('File Base'));
        });

        it('draws a selection change once, when the arrow key makes it', () => {
            const before = dash.writes.length;
            dash.views()[1].focusNext();
            const moved = Buffer.concat(dash.writes.slice(before)).toString('latin1');
            [4, 5].forEach(r => assert.ok(rowsDrawn(moved).includes(r), `row ${r}`));
            assert.equal(dash.wfc.selectedSessionId, sid(1));

            //  the refresh has nothing to add
            const t = dash.tick();
            assert.equal(t.writes, 1);
            assert.deepEqual(rowsDrawn(t.wire.toString('latin1')), [STATUS_BAR_ROW]);
        });

        it('puts the bar on the selection when something else moved it', () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '3' }, {}, () => {});
            dash.views()[1].setFocusItemIndex(0); //  no 'index update', as setFocusItemIndex()
            const t = dash.tick();
            const rows = rowsDrawn(t.wire.toString('latin1'));
            [4, 5, 6].forEach(r => assert.ok(rows.includes(r), `row ${r}`));
            assert.equal(dash.views()[1].getFocusItemIndex(), 2);
        });

        it('blanks the old footprint when the list shrinks', () => {
            dash.disconnect(dash.connections[2]);
            const t = dash.tick();
            const counts = gotoCounts(t.wire.toString('latin1'));
            //  blank pass over every row, then two items and three spare rows
            assertRowPasses(counts, NODE_ROWS, 2);
        });

        it('paints the whole list again once form 0 is rebuilt', () => {
            dash.redisplay();
            const t = dash.tick();
            const rows = rowsDrawn(t.wire.toString('latin1'));
            NODE_ROWS.forEach(r => assert.ok(rows.includes(r), `row ${r}`));
            LOG_ROWS.forEach(r => assert.ok(rows.includes(r), `log row ${r}`));
            //  and the custom views
            [4, 9, 10, 13, 16].forEach(r => assert.ok(rows.includes(r), `row ${r}`));
        });

        it('leaves the screen as a full repaint would', () => {
            dash.connections[1].currentMenuModule.menuConfig.desc = 'Doors';
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '2' }, {}, () => {});

            //  the screen as drawn tick by tick since the first paint
            dash.tick();
            dash.tick();
            const incremental = new VirtualScreen().write(
                Buffer.concat(dash.writes).toString('latin1')
            );

            //  the same state painted from scratch
            dash.redisplay();
            dash.writes.length = 0;
            dash.tick();
            const fresh = new VirtualScreen().write(
                Buffer.concat(dash.writes).toString('latin1')
            );

            const region = vs =>
                vs
                    .text()
                    .slice(3, 23)
                    .map(r => r.slice(0, 80));
            assert.deepEqual(region(incremental), region(fresh));
        });

        it('fills the selection info on the first refresh and after a disconnect', () => {
            dash.cleanup(); //  its nodes would be listed too
            const fresh = buildDashboard({ nodes: 3 });
            try {
                const shown = [];
                const selection = {
                    setText: t => shown.push(t),
                };
                const views = fresh.views();
                const getView = fresh.wfc.viewControllers.main.getView;
                fresh.wfc.viewControllers.main.getView = id =>
                    3 === id ? selection : getView(id);
                assert.equal(views[1].getCount(), 0);

                fresh.tick();
                assert.equal(shown.length, 1);
                assert.ok(shown[0].includes('Sysop Real'));

                fresh.wfc.menuMethods.setNodeStatusSelection({ ch: '3' }, {}, () => {});
                fresh.tick();
                fresh.disconnect(fresh.connections[2]);
                fresh.wfc._clientDisconnected({});
                assert.equal(fresh.wfc.selectedNodeStatusIndex, 0);
                assert.equal(views[1].getCount(), 2);
                assert.equal(views[1].getFocusItemIndex(), 0);
                //  cleared, then the item now at the top
                assert.ok(shown.includes(''));
                assert.ok(shown[shown.length - 1].includes('Sysop Real'));
            } finally {
                fresh.cleanup();
            }
        });
    });

    describe('node selection', () => {
        const view = () => dash.views()[1];
        const selectionShown = () => {
            const shown = [];
            const selection = { setText: t => shown.push(t) };
            const getView = dash.wfc.viewControllers.main.getView;
            dash.wfc.viewControllers.main.getView = id =>
                3 === id ? selection : getView(id);
            return shown;
        };

        it('stays where the arrow keys put it', () => {
            view().focusNext();
            const t = dash.tick();
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.wfc._getSelectedNodeItem().node, 2);
            assert.equal(dash.wfc.selectedSessionId, sid(1));
            assert.equal(dash.wfc.selectedNodeStatusIndex, 1);
            //  nothing was put back: the status bar's one write, no list rows
            assert.equal(t.writes, 1);
            assert.deepEqual(rowsDrawn(t.wire.toString('latin1')), [STATUS_BAR_ROW]);

            const idle = dash.tick();
            assert.equal(idle.writes, 1, 'the status bar only');
            assert.deepEqual(rowsDrawn(idle.wire.toString('latin1')), [STATUS_BAR_ROW]);
        });

        it('page and last keys are followed too', () => {
            view().focusLast();
            dash.tick();
            assert.equal(view().getFocusItemIndex(), 2);
            assert.equal(dash.wfc._getSelectedNodeItem().node, 3);
        });

        it('stays on an arrowed node after a node-number key', () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '3' }, {}, () => {});
            view().focusPrevious();
            dash.tick();
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.wfc._getSelectedNodeItem().node, 2);
        });

        it('keeps the selected node when another one above it disconnects', () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '3' }, {}, () => {});
            const shown = selectionShown();
            dash.disconnect(dash.connections[1]); //  node 2, above it
            dash.wfc._clientDisconnected({});
            assert.equal(view().getCount(), 2);
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.wfc.selectedSessionId, sid(2));
            assert.equal(dash.wfc._getSelectedNodeItem().node, 3);
            assert.ok(shown[shown.length - 1].includes('Bob Real'), shown.join('|'));

            dash.tick();
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.tick().writes, 1);
        });

        it('falls back to the first row when the selected node disconnects', () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '3' }, {}, () => {});
            const shown = selectionShown();
            dash.disconnect(dash.connections[2]);
            dash.tick(); //  seen by the refresh before the disconnect event
            assert.equal(view().getFocusItemIndex(), 0);
            assert.equal(dash.wfc.selectedSessionId, sid(0));
            assert.ok(shown[shown.length - 1].includes('Sysop Real'), shown.join('|'));
            assert.equal(dash.tick().writes, 1);
        });

        it('does not pass to a new caller who gets the number of the one that left', () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '2' }, {}, () => {});
            const left = dash.connections[1];
            //  a sub-viewer owns the screen: no refresh runs while node 2 leaves
            dash.wfc.viewControllers.messages = {};
            dash.disconnect(left);
            dash.wfc._clientDisconnected({});
            const newcomer = dash.connect(2, 'Mallory', {
                lastLoginTs: new Date().toISOString(),
            });
            delete dash.wfc.viewControllers.messages;

            dash.tick();
            const item = dash.wfc._getSelectedNodeItem();
            assert.notEqual(item.sessionId, newcomer.session.uniqueId);
            assert.equal(view().getFocusItemIndex(), 0);
            assert.equal(item.node, 1);
            assert.equal(dash.wfc.selectedSessionId, sid(0));
        });

        it('is followed on a theme with no selection info view', () => {
            dash.wfc.viewControllers.main.getView = id =>
                3 === id ? undefined : dash.views()[id];
            view().focusNext();
            dash.tick();
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.wfc.selectedSessionId, sid(1));
            assert.equal(dash.tick().writes, 1);
        });

        it('an empty list is not repainted on an idle tick', () => {
            dash.disconnect(dash.connections[0]);
            dash.disconnect(dash.connections[1]);
            dash.disconnect(dash.connections[2]);
            dash.wfc._clientDisconnected({});
            dash.tick();
            assert.equal(view().getCount(), 0);
            for (let i = 0; i < 3; ++i) {
                const t = dash.tick();
                assert.equal(t.writes, 1, 'the status bar only');
                assert.deepEqual(rowsDrawn(t.wire.toString('latin1')), [STATUS_BAR_ROW]);
            }

            //  a caller connects: painted and selected
            const caller = dash.connect(4, 'Zed', {
                lastLoginTs: new Date().toISOString(),
            });
            const t = dash.tick();
            assert.ok(rowsDrawn(t.wire.toString('latin1')).includes(4));
            assert.ok(t.wire.toString('latin1').includes('Zed'));
            assert.equal(dash.wfc.selectedSessionId, caller.session.uniqueId);
            assert.equal(view().getFocusItemIndex(), 0);
            assert.equal(dash.tick().writes, 1);
        });

        it('updates the panel for a lost selection replaced by a look-alike row', () => {
            //  the selected session is replaced by another one that draws the
            //  same, at the row the bar is on: nothing to repaint, but the
            //  selection is a new session and the panel must follow
            dash.cleanup();
            const fresh = buildDashboard({ nodes: 1 });
            try {
                const shown = [];
                const selection = { setText: t => shown.push(t) };
                const main = fresh.wfc.viewControllers.main;
                const getView = main.getView;
                main.getView = id => (3 === id ? selection : getView(id));
                fresh.tick();
                const first = fresh.wfc.selectedSessionId;
                shown.length = 0;

                fresh.disconnect(fresh.connections[0]);
                const again = fresh.connect(1, 'Sysop', {
                    lastLoginTs: new Date('2026-11-14T10:00:00Z').toISOString(),
                    desc: '-WFC-',
                });
                fresh.tick();
                assert.notEqual(fresh.wfc.selectedSessionId, first);
                assert.equal(fresh.wfc.selectedSessionId, again.session.uniqueId);
                assert.equal(shown.length, 1, 'panel updated');
                assert.ok(shown[0].includes('Sysop Real'));
            } finally {
                fresh.cleanup();
            }
        });

        it('is not changed by a node connecting', () => {
            view().focusNext();
            dash.connect(9, 'Eve', { lastLoginTs: new Date().toISOString() });
            const t = dash.tick();
            assert.equal(view().getCount(), 4);
            assert.equal(view().getFocusItemIndex(), 1);
            assert.equal(dash.wfc.selectedSessionId, sid(1));
            assert.ok(rowsDrawn(t.wire.toString('latin1')).includes(7), 'new row drawn');
        });
    });

    describe('kick', () => {
        const confirm = () => {
            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '2' }, {}, () => {});
            const main = dash.wfc.viewControllers.main;
            const getView = main.getView;
            main.getView = id =>
                CONFIRM_XY === id
                    ? { dimens: { width: 10 }, position: { row: 20, col: 5 } }
                    : getView(id);
            //  the prompt itself needs art; stop at opening it
            dash.wfc.promptForInput = () => {};
            dash.wfc.menuMethods.kickSelectedNode({}, {}, () => {});
            main.getView = getView;
            assert.ok(dash.wfc._kickTarget, 'prompt opened');
        };
        const yes = () => dash.wfc.menuMethods.kickNodeYes({}, {}, () => {});

        it('kicks the caller that was confirmed', () => {
            confirm();
            const target = dash.connections[1];
            yes();
            assert.ok(target.ended);
            assert.ok(!dash.connections[0].ended && !dash.connections[2].ended);
        });

        it('kicks nobody if the confirmed caller hung up during the prompt', () => {
            confirm();
            dash.disconnect(dash.connections[1]);
            dash.wfc._clientDisconnected({}); //  selection falls back to row 0
            yes();
            dash.connections.forEach(c => assert.ok(!c.ended));
        });

        it('kicks nobody if a new caller has the number meanwhile', () => {
            confirm();
            dash.disconnect(dash.connections[1]);
            const newcomer = dash.connect(2, 'Mallory', {
                lastLoginTs: new Date().toISOString(),
            });
            yes();
            assert.ok(!newcomer.ended);
            dash.connections.forEach(c => assert.ok(!c.ended));
        });

        it('forgets the target when the op says no, or after one kick', () => {
            confirm();
            dash.wfc.menuMethods.kickNodeNo({}, {}, () => {});
            assert.equal(dash.wfc._kickTarget, undefined);
            let err;
            dash.wfc.menuMethods.kickNodeYes({}, {}, e => (err = e));
            assert.ok(err);
            dash.connections.forEach(c => assert.ok(!c.ended));
        });
    });

    describe('node selection info', () => {
        it('is not redrawn by an idle refresh, and shows fresh values when selected', () => {
            const shown = [];
            const selection = { setText: t => shown.push(t) };
            const getView = dash.wfc.viewControllers.main.getView;
            dash.wfc.viewControllers.main.getView = id =>
                3 === id ? selection : getView(id);

            //  luciano's nodeStatusSelectionFormat shows the remote address,
            //  which the list itself does not
            dash.connections[1].friendlyRemoteAddress = () => '192.0.2.42';
            dash.tick();
            dash.tick();
            assert.equal(shown.length, 0, 'the refresh leaves it alone, as on master');

            dash.wfc.menuMethods.setNodeStatusSelection({ ch: '2' }, {}, () => {});
            assert.equal(shown.length, 1);
            assert.ok(shown[0].includes('192.0.2.42'), shown[0]);
        });
    });

    describe('quick log', () => {
        it('a new record with the same number of rows does not blank them first', () => {
            dash.addLog('something happened');
            const t = dash.tick();
            const counts = gotoCounts(t.wire.toString('latin1'));
            assertRowPasses(counts, LOG_ROWS, 1);
            assert.ok(t.wire.toString('latin1').includes('something happened'));
        });

        it('a log that grows still blanks the old footprint', () => {
            dash.cleanup();
            const fresh = buildDashboard({ nodes: 1 });
            try {
                fresh.wfc.logRingBuffer.records.splice(0, 3); //  two rows
                fresh.tick();
                fresh.addLog('third');
                const t = fresh.tick();
                const counts = gotoCounts(t.wire.toString('latin1'));
                assertRowPasses(counts, LOG_ROWS, 2);
            } finally {
                fresh.cleanup();
            }
        });
    });

    describe('task screen custom views', () => {
        function tasksScreen() {
            const client = dash.client;
            const views = {
                10: new TextView({
                    client,
                    id: 10,
                    position: { row: 20, col: 5 },
                    dimens: { width: 40 },
                }),
                11: new TextView({
                    client,
                    id: 11,
                    position: { row: 11, col: 49 },
                    dimens: { width: 30 },
                }),
                3: { position: { row: 20, col: 5 } }, //  %XY3
            };
            Object.values(views).forEach(v => v.redraw && v.redraw());
            const wfc = dash.wfc;
            wfc._stopRefreshing();
            wfc._releaseMainForm();
            wfc.viewControllers.tasks = {
                getView: id => views[id],
                getFocusedView: () => null,
                detachClientEvents: () => {},
            };
            wfc._tasksMode = 'art';
            wfc._taskRows = [];
            Object.assign(wfc.menuConfig.config, {
                tasksInfoFormat10: '{taskActionResult}',
                tasksInfoFormat11: '{runningTaskCount} running, {taskCount} tasks',
            });
            wfc._taskCountStats = () => ({ runningTaskCount: 1 });
            return { wfc, views };
        }

        const wire = () => Buffer.concat(dash.writes).toString('latin1');

        it('draws only what changed, once a second', () => {
            const { wfc } = tasksScreen();
            wfc._paintTasksInfo();
            dash.writes.length = 0;
            wfc._paintTasksInfo();
            assert.equal(dash.writes.length, 0);
        });

        it('draws them all after a line was written over the screen', () => {
            const { wfc } = tasksScreen();
            wfc._paintTasksInfo();
            //  the y/N prompt (or a result) at %XY3, on the row of TL10
            wfc._writeTasksLine({ row: 20, col: 5 }, 'Run it? [y/N]');
            dash.writes.length = 0;
            wfc._paintTasksInfo();
            const rows = rowsDrawn(wire());
            assert.ok(rows.includes(20), 'TL10 drawn again over the prompt line');
            assert.ok(rows.includes(11), 'TL11 drawn again');

            dash.writes.length = 0;
            wfc._paintTasksInfo();
            assert.equal(dash.writes.length, 0, 'and then only on change again');
        });
    });
});

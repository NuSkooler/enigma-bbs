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

const STATUS_BAR_ROW = 1;
const NODE_ROWS = [4, 5, 6, 7, 8];
const LOG_ROWS = [19, 20, 21, 22, 23];

describe('WFC refresh paints only what changed', () => {
    let dash;

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

        it('repaints when the selection changes', () => {
            dash.wfc.selectedNodeStatusIndex = 2;
            const t = dash.tick();
            const rows = rowsDrawn(t.wire.toString('latin1'));
            [4, 5, 6].forEach(r => assert.ok(rows.includes(r), `row ${r}`));
            assert.equal(dash.views()[1].getFocusItemIndex(), 2);

            const again = dash.tick();
            assert.deepEqual(rowsDrawn(again.wire.toString('latin1')), [STATUS_BAR_ROW]);
        });

        it('puts back a bar the op moved with the arrow keys, as before', () => {
            const view = dash.views()[1];
            view.focusNext(); //  draws on its own
            assert.equal(view.getFocusItemIndex(), 1);

            const t = dash.tick();
            const rows = rowsDrawn(t.wire.toString('latin1'));
            [4, 5, 6].forEach(r => assert.ok(rows.includes(r), `row ${r}`));
            assert.equal(view.getFocusItemIndex(), 0);
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
            dash.wfc.selectedNodeStatusIndex = 1;

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

                fresh.wfc.selectedNodeStatusIndex = 2;
                fresh.tick();
                fresh.disconnect(fresh.connections[2]);
                fresh.wfc._clientDisconnected({});
                assert.equal(fresh.wfc.selectedNodeStatusIndex, 0);
                assert.equal(views[1].getCount(), 2);
                assert.equal(views[1].getFocusItemIndex(), 0);
                //  cleared, then the item now at the top
                assert.equal(shown[shown.length - 2], '');
                assert.ok(shown[shown.length - 1].includes('Sysop Real'));
            } finally {
                fresh.cleanup();
            }
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

'use strict';

//
//  EchoMail export scan: which messages it exports, and its retry of an
//  uplink that failed (issue #1026).
//
//  The scan selects the messages in an area above its watermark that carry no
//  System/state_flags0 row, or one holding only ActivityPubExported (#1032). The exporter writes that row (Exported,
//  with the MSGID) as soon as a message is handed to its first destination,
//  before anything is delivered. So once one uplink had taken a message, an
//  uplink that failed -- a move into outbound, a busy flow file, a second
//  uplink that was down -- never saw it again, although the log said "will
//  retry".
//
//  Now every uplink a message is for is recorded as owed it
//  (System/ftn_export_pending), in the same transaction as the Exported bit,
//  and each uplink's row is cleared once its packets are in outbound. The scan
//  retries what is left, to those uplinks only.
//
//  The first part pins which kinds of message the scan exports. #1026 left
//  that set alone. #1032 changed it in one place only: the ActivityPub tosser
//  used to flag what it delivered Exported, the bit this exporter writes, so in
//  an area that is both federated and an FTN echo a local post ActivityPub got
//  to first never reached the echo. ActivityPub now has a bit of its own, which
//  the scan does not count. Messages flagged before that keep their '2' and
//  stay as they were: nothing already in the base is exported on upgrade.
//

const { strict: assert } = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness, AREAS, U1, U2, U3 } = require('./ftn_export_harness.js');

const UPLINK_BY_NODE = { 701: U1, 702: U2, 703: U3 };

describe('ftn_bso — EchoMail export scan eligibility and retry (#1026)', function () {
    this.timeout(20000);

    const h = createHarness();
    before(() => h.setup('ftnretry'));
    after(() => h.teardown());

    beforeEach(async () => {
        h.logged.length = 0;
        h.db.exec(
            'DELETE FROM message_area_last_scan; DELETE FROM message_meta; DELETE FROM message;'
        );
        for (const d of ['outbound', 'temp']) {
            await fsp.rm(path.join(h.root, d), { recursive: true, force: true });
            await fsp.mkdir(path.join(h.root, d), { recursive: true });
        }
    });

    //
    //  Every message each uplink has been given so far, as
    //  { uplink: [ { subject, msgId } ] } -- duplicates included, since
    //  packets stay in outbound (no mailer runs here).
    //
    async function delivered() {
        const out = { [U1]: [], [U2]: [], [U3]: [] };
        const dir = path.join(h.root, 'outbound', 'outbound');
        const entries = await fsp.readdir(dir).catch(() => []);
        for (const name of entries.filter(e => /\.[a-z]lo$/i.test(e))) {
            const node = parseInt(name.slice(4, 8), 16);
            const uplink = UPLINK_BY_NODE[node];
            const refs = (await fsp.readFile(path.join(dir, name), 'utf8'))
                .split('\n')
                .filter(Boolean)
                .map(l => l.replace(/^[\^#~!@-]/, ''));
            for (const ref of refs) {
                const text = (await fsp.readFile(ref)).toString('latin1');
                for (const [, subject, msgId] of text.matchAll(
                    /\x00([^\x00]+)\x00(?:AREA:[^\r]*\r)?[^\x00]*?\x01MSGID: ([^\r]+)\r/g
                )) {
                    out[uplink].push({ subject, msgId });
                }
            }
        }
        return out;
    }

    function subjectsOf(deliveredTo) {
        return Object.fromEntries(
            Object.entries(deliveredTo).map(([uplink, list]) => [
                uplink,
                list.map(m => m.subject).sort(),
            ])
        );
    }

    function persist(message) {
        return new Promise((resolve, reject) =>
            message.persist(err => (err ? reject(err) : resolve(message)))
        );
    }

    let seq = 0;
    function makeMessage({ areaTag = 'local_a', subject, system = {}, meta = {} }) {
        ++seq;
        const message = new h.Message({
            areaTag,
            toUserName: 'All',
            fromUserName: 'Somebody',
            subject,
            message: `Body ${seq}.`,
            modTimestamp: `2026-10-02T12:00:${String(seq % 60).padStart(2, '0')}.000-05:00`,
        });
        Object.assign(message.meta.System, system);
        Object.assign(message.meta, meta);
        return persist(message);
    }

    function stateFlags(message) {
        return h.db
            .prepare(
                `SELECT meta_value FROM message_meta WHERE message_id = ?
                AND meta_category = 'System' AND meta_name = 'state_flags0';`
            )
            .all(message.messageId)
            .map(r => r.meta_value);
    }

    function scanId(scanToss = 'ftn_bso', areaTag = 'local_a') {
        const row = h.db
            .prepare(
                'SELECT message_id FROM message_area_last_scan WHERE scan_toss = ? AND area_tag = ?;'
            )
            .get(scanToss, areaTag);
        return row ? row.message_id : undefined;
    }

    // ─── which messages the scan exports ─────────────────────────────────────

    describe('eligibility', () => {
        //
        //  One message of each kind that can end up in an FTN EchoMail area,
        //  with the flags the code that writes it gives it:
        //
        //  * a post from a terminal, NNTP or the REST API (persistMessage):
        //    no flags
        //  * a QWK / Blue Wave reply a user uploaded
        //    (message_base_offline_import.js): no flags, a local from-user,
        //    external flavor from the area
        //  * an ActivityPub note imported from the fediverse: no flags (the
        //    inbox never writes state_flags0); only reaches an FTN area if an
        //    operator maps activitypub_shared as one
        //  * a local post the ActivityPub tosser exported first, before #1032:
        //    Exported (2), written raw, with ActivityPub ids and no MSGID
        //  * the same since #1032: ActivityPubExported (8), with the ids
        //  * EchoMail imported from an FTN network: Imported (1)
        //  * EchoMail relayed on: Imported|Exported (3)
        //  * a post already exported to FTN, e.g. live, with the area's
        //    watermark lagging behind it: Exported (2) and its MSGID
        //  * a message an email export failed for: ExportFailed (4) -- email
        //    is private mail only; here for the bit, not the route
        //  * a NetMail: private_mail, which is never an EchoMail area
        //
        async function addOneOfEach() {
            const m = {};
            m.local = await h.addLocal({ subject: 'elig local post' });
            m.offline = await makeMessage({
                subject: 'elig qwk reply',
                system: { local_from_user_id: '2', external_flavor: 'local' },
                meta: { FtnKludge: { PID: 'QWKREADER 1.0' } },
            });
            m.apImported = await makeMessage({
                subject: 'elig ap imported',
                system: {
                    external_flavor: 'activitypub',
                    remote_from_user: 'https://example.com/users/someone',
                },
            });
            m.apExported = await makeMessage({
                subject: 'elig ap exported',
                system: { local_from_user_id: '2', state_flags0: '2' },
                meta: {
                    ActivityPub: {
                        activitypub_activity_id: 'https://bbs.example/a/1',
                        activitypub_note_id: 'https://bbs.example/n/1',
                    },
                },
            });
            m.apExportedNow = await makeMessage({
                subject: 'elig ap exported now',
                system: { local_from_user_id: '2', state_flags0: '8' },
                meta: {
                    ActivityPub: {
                        activitypub_activity_id: 'https://bbs.example/a/2',
                        activitypub_note_id: 'https://bbs.example/n/2',
                    },
                },
            });
            m.ftnImported = await h.addImported({
                areaTag: 'local_a',
                subject: 'elig ftn imported',
                msgId: '1:218/701 000000a1',
            });
            m.relayed = await makeMessage({
                subject: 'elig relayed',
                system: { state_flags0: '3' },
                meta: { FtnKludge: { MSGID: '1:218/701 000000a2' } },
            });
            m.ftnExported = await makeMessage({
                subject: 'elig ftn exported live',
                system: { local_from_user_id: '2', state_flags0: '2' },
                meta: { FtnKludge: { MSGID: '1:218/700 000000a3' } },
            });
            m.emailFailed = await makeMessage({
                subject: 'elig export failed',
                system: { state_flags0: '4' },
            });
            m.netMail = await makeMessage({
                areaTag: 'private_mail',
                subject: 'elig netmail',
                system: {
                    external_flavor: 'ftn',
                    remote_to_user: '1:218/701',
                },
            });
            return m;
        }

        const EXPORTED = [
            'elig ap exported now',
            'elig ap imported',
            'elig local post',
            'elig qwk reply',
        ];

        it('exports exactly the messages that carry no state flags but ActivityPubExported, to every uplink', async () => {
            const m = await addOneOfEach();
            const result = await h.runExportScan(h.makeModule());
            assert.ok(!result.err, result.err && result.err.message);

            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: EXPORTED,
                [U2]: EXPORTED,
                [U3]: EXPORTED,
            });
            //  the watermark moves to the last message exported
            assert.equal(scanId(), m.apExportedNow.messageId);
            //  ... and the one ActivityPub delivered is now FTN's too
            assert.deepEqual(stateFlags(m.apExportedNow), ['10']);
            assert.equal(h.storedMsgId(m.apExportedNow).length, 1);
            assert.deepEqual(stateFlags(m.apExported), ['2']);
        });

        it('exports none of them a second time', async () => {
            await addOneOfEach();
            await h.runExportScan(h.makeModule());
            const first = subjectsOf(await delivered());

            const again = await h.runExportScan(h.makeModule());
            assert.ok(!again.err, again.err && again.err.message);
            assert.deepEqual(subjectsOf(await delivered()), first);
        });

        it('still skips a message already exported above the watermark, after the upgrade', async () => {
            //  Master's live export never moves the area's watermark, and the
            //  scan does not move it over messages it skips. So a board that
            //  exports @immediate has its exported posts above the watermark.
            //  They were delivered; nothing may send them again.
            const exportedLive = await makeMessage({
                subject: 'already out',
                system: { state_flags0: '2' },
                meta: { FtnKludge: { MSGID: '1:218/700 000000b1' } },
            });
            const fresh = await h.addLocal({ subject: 'fresh after upgrade' });
            h.db
                .prepare(
                    `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
                VALUES ('ftn_bso', 'local_a', ?);`
                )
                .run(exportedLive.messageId - 1);

            const result = await h.runExportScan(h.makeModule());
            assert.ok(!result.err, result.err && result.err.message);
            const only = ['fresh after upgrade'];
            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: only,
                [U2]: only,
                [U3]: only,
            });
            assert.equal(scanId(), fresh.messageId);
        });
    });

    // ─── an area that is both ActivityPub and FTN (#1032) ────────────────────

    //
    //  local_a stands in for activitypub_shared mapped as an FTN echo. The
    //  ActivityPub side is the tosser's own step that records a delivered
    //  Note (_markExported); delivering the Note is not what is under test.
    //
    describe('an area that is both ActivityPub and FTN (#1032)', () => {
        let tosser;
        before(() => {
            //  Required here, not at load: see activitypub_note.test.js. And
            //  not constructed: the module may already be loaded, holding
            //  whatever logger another test file had installed at the time.
            //  _markExported() writes through the message it is given and
            //  uses nothing set up by the constructor.
            const ApTosser = require('../core/scanner_tossers/activitypub.js').getModule;
            tosser = Object.create(ApTosser.prototype);
        });

        let apSeq = 0;
        function apExport(message) {
            ++apSeq;
            const activity = {
                id: `https://bbs.example/activities/${apSeq}`,
                object: { id: `https://bbs.example/notes/${apSeq}` },
            };
            return new Promise(resolve =>
                tosser._markExported(message, activity, err => resolve({ err, activity }))
            );
        }

        function apIds(message) {
            return h.db
                .prepare(
                    `SELECT meta_name, meta_value FROM message_meta
                    WHERE message_id = ? AND meta_category = 'ActivityPub'
                    ORDER BY meta_name;`
                )
                .all(message.messageId)
                .map(r => `${r.meta_name}=${r.meta_value}`);
        }

        function idsOf(activity) {
            return [
                `activitypub_activity_id=${activity.id}`,
                `activitypub_note_id=${activity.object.id}`,
            ];
        }

        it('sends a post ActivityPub delivered first to the echo, on the next scheduled scan', async () => {
            const message = await h.addLocal({ subject: 'ap first' });
            const ap = await apExport(message);
            assert.ok(!ap.err, ap.err && ap.err.message);
            const apFlags = stateFlags(message);

            const scan = await h.runExportScan(h.makeModule());
            assert.ok(!scan.err, scan.err && scan.err.message);
            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: ['ap first'],
                [U2]: ['ap first'],
                [U3]: ['ap first'],
            });
            const minted = h.storedMsgId(message);
            assert.equal(minted.length, 1);
            assertEachOnce(await tally(), ['ap first'], [U1, U2, U3], () => minted);

            assert.deepEqual(apFlags, [
                String(h.Message.StateFlags0.ActivityPubExported),
            ]);

            //  both bits, one row; the ActivityPub ids untouched
            assert.deepEqual(stateFlags(message), [
                String(
                    h.Message.StateFlags0.ActivityPubExported |
                        h.Message.StateFlags0.Exported
                ),
            ]);
            assert.deepEqual(apIds(message), idsOf(ap.activity));
            assert.equal(scanId(), message.messageId);

            //  and never again
            const again = await h.runExportScan(h.makeModule());
            assert.ok(!again.err, again.err && again.err.message);
            assertEachOnce(await tally(), ['ap first'], [U1, U2, U3], () => minted);
        });

        it('records the ActivityPub ids for a post FTN exported first, and FTN does not send it again', async () => {
            const mod = h.makeModule();
            const message = await h.addLocal({ subject: 'ftn first' });
            const live = await h.runLiveExport(mod, message);
            assert.ok(!live.err, live.err && live.err.message);
            assert.deepEqual(stateFlags(message), [
                String(h.Message.StateFlags0.Exported),
            ]);
            const minted = h.storedMsgId(message);

            //  used to fail on the UNIQUE key, before the ids were stored
            const ap = await apExport(message);
            assert.ok(!ap.err, ap.err && ap.err.message);
            assert.deepEqual(stateFlags(message), [
                String(
                    h.Message.StateFlags0.ActivityPubExported |
                        h.Message.StateFlags0.Exported
                ),
            ]);
            assert.deepEqual(apIds(message), idsOf(ap.activity));
            assert.deepEqual(h.storedMsgId(message), minted);

            //  a live export leaves the watermark behind it: the scan must
            //  still pass over it
            const scan = await h.runExportScan(mod);
            assert.ok(!scan.err, scan.err && scan.err.message);
            assertEachOnce(await tally(), ['ftn first'], [U1, U2, U3], () => minted);
        });

        it('records a second delivery of the same message without error or a second flag row', async () => {
            const message = await h.addLocal({ subject: 'ap twice' });
            const first = await apExport(message);
            assert.ok(!first.err, first.err && first.err.message);
            const second = await apExport(message);
            assert.ok(!second.err, second.err && second.err.message);
            assert.deepEqual(stateFlags(message), [
                String(h.Message.StateFlags0.ActivityPubExported),
            ]);
        });

        it('never exports EchoMail imported from FTN, ActivityPub flagged or not', async () => {
            const imported = await h.addImported({
                areaTag: 'local_a',
                subject: 'imported, both-area',
                msgId: '1:218/701 000000d1',
            });
            const importedApToo = await h.addImported({
                areaTag: 'local_a',
                subject: 'imported, ap flagged',
                msgId: '1:218/701 000000d2',
            });
            //  The AP tosser never sees imported mail (import does not go
            //  through persistMessage), but should anything ever flag it
            const ap = await apExport(importedApToo);
            assert.ok(!ap.err, ap.err && ap.err.message);
            assert.deepEqual(stateFlags(importedApToo), [
                String(
                    h.Message.StateFlags0.ActivityPubExported |
                        h.Message.StateFlags0.Imported
                ),
            ]);

            const scan = await h.runExportScan(h.makeModule());
            assert.ok(!scan.err, scan.err && scan.err.message);
            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: [],
                [U2]: [],
                [U3]: [],
            });
            assert.deepEqual(stateFlags(imported), [
                String(h.Message.StateFlags0.Imported),
            ]);
            assert.equal(scanId(), undefined);
        });

        it('in an area that is ActivityPub only: flagged and recorded, and FTN never sees it', async () => {
            const message = await h.addLocal({
                areaTag: 'activitypub_shared',
                subject: 'ap only',
            });
            const ap = await apExport(message);
            assert.ok(!ap.err, ap.err && ap.err.message);
            assert.deepEqual(stateFlags(message), [
                String(h.Message.StateFlags0.ActivityPubExported),
            ]);
            assert.deepEqual(apIds(message), idsOf(ap.activity));

            const scan = await h.runExportScan(h.makeModule());
            assert.ok(!scan.err, scan.err && scan.err.message);
            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: [],
                [U2]: [],
                [U3]: [],
            });
            assert.equal(scanId('ftn_bso', 'activitypub_shared'), undefined);
        });

        it('flags ActivityPub private mail Exported as well, which the sent-mail trim looks for', async () => {
            const message = await h.addLocal({
                areaTag: 'private_mail',
                subject: 'ap private',
            });
            const ap = await apExport(message);
            assert.ok(!ap.err, ap.err && ap.err.message);
            assert.deepEqual(stateFlags(message), [
                String(
                    h.Message.StateFlags0.ActivityPubExported |
                        h.Message.StateFlags0.Exported
                ),
            ]);
        });

        it('in an area that is FTN only: exported and flagged as before', async () => {
            const message = await h.addLocal({ subject: 'ftn only' });
            const scan = await h.runExportScan(h.makeModule());
            assert.ok(!scan.err, scan.err && scan.err.message);
            const minted = h.storedMsgId(message);
            assertEachOnce(await tally(), ['ftn only'], [U1, U2, U3], () => minted);
            assert.deepEqual(stateFlags(message), [
                String(h.Message.StateFlags0.Exported),
            ]);
            assert.deepEqual(apIds(message), []);
        });
    });

    // ─── retry ───────────────────────────────────────────────────────────────

    function pendingRows() {
        return h.db
            .prepare(
                `SELECT m.subject, mm.meta_value AS uplink
                FROM message_meta mm JOIN message m ON m.message_id = mm.message_id
                WHERE mm.meta_category = 'System' AND mm.meta_name = 'ftn_export_pending'
                ORDER BY m.message_id, mm.meta_value;`
            )
            .all()
            .map(r => `${r.subject} -> ${r.uplink}`);
    }

    //  |mod|'s delivery to |uplink| fails while |state.down| is set: after
    //  packetising, so the message is already flagged -- the #1026 case.
    function uplinkDown(mod, uplink) {
        const state = { down: true, attempts: 0 };
        const deliver = mod.deliverEchoMailPackets;
        mod.deliverEchoMailPackets = function (dest, files, cb) {
            if (dest.uplink === uplink) {
                ++state.attempts;
                if (state.down) {
                    return cb(new Error(`${uplink} is down`));
                }
            }
            return deliver.call(this, dest, files, cb);
        };
        return state;
    }

    //  Each uplink's messages, by subject, with how many times each arrived
    //  and the MSGIDs it arrived with.
    async function tally() {
        const out = {};
        for (const [uplink, list] of Object.entries(await delivered())) {
            out[uplink] = {};
            for (const { subject, msgId } of list) {
                const t = (out[uplink][subject] = out[uplink][subject] || {
                    count: 0,
                    msgIds: new Set(),
                });
                ++t.count;
                t.msgIds.add(msgId);
            }
        }
        return out;
    }

    function assertEachOnce(t, subjects, uplinks, storedMsgId) {
        for (const uplink of uplinks) {
            for (const subject of subjects) {
                const got = t[uplink][subject];
                assert.ok(got, `${uplink} never got "${subject}"`);
                assert.equal(
                    got.count,
                    1,
                    `${uplink} got "${subject}" ${got.count} times`
                );
                if (storedMsgId) {
                    assert.deepEqual(
                        Array.from(got.msgIds),
                        storedMsgId(subject),
                        `${uplink}: "${subject}" carries the stored MSGID`
                    );
                }
            }
        }
    }

    describe('retry', () => {
        it('retries an uplink that failed, and only that uplink, with the same MSGID', async () => {
            const mod = h.makeModule();
            const down = uplinkDown(mod, U2);
            const m1 = await h.addLocal({ subject: 'retry one' });
            const m2 = await h.addLocal({ subject: 'retry two' });

            const first = await h.runExportScan(mod);
            assert.ok(!first.err, first.err && first.err.message);
            let t = await tally();
            assert.deepEqual(Object.keys(t[U2]), [], 'U2 got nothing');
            assertEachOnce(t, ['retry one', 'retry two'], [U1, U3]);
            assert.deepEqual(pendingRows(), [`retry one -> ${U2}`, `retry two -> ${U2}`]);
            const msgIds = {
                'retry one': h.storedMsgId(m1),
                'retry two': h.storedMsgId(m2),
            };
            assert.equal(msgIds['retry one'].length, 1);
            //  held, as #818 made it
            assert.equal(scanId(), undefined);

            //  new mail meanwhile goes to everyone, once
            await h.addLocal({ subject: 'retry three' });
            down.down = false;
            const second = await h.runExportScan(mod);
            assert.ok(!second.err, second.err && second.err.message);

            t = await tally();
            assertEachOnce(
                t,
                ['retry one', 'retry two'],
                [U1, U2, U3],
                subject => msgIds[subject]
            );
            assertEachOnce(t, ['retry three'], [U1, U2, U3]);
            assert.deepEqual(h.storedMsgId(m1), msgIds['retry one'], 'MSGID unchanged');
            assert.deepEqual(pendingRows(), []);

            //  and nothing more after that
            const third = await h.runExportScan(mod);
            assert.ok(!third.err, third.err && third.err.message);
            assert.deepEqual(await tally(), t);
        });

        it('retries a failed move into outbound (the #818 reproduction)', async () => {
            const message = await h.addLocal({ subject: 'unmovable' });
            const outboundDir = path.join(h.root, 'outbound', 'outbound');
            await fsp.mkdir(outboundDir, { recursive: true });

            await fsp.chmod(outboundDir, 0o500);
            try {
                await h.runExportScan(h.makeModule());
            } finally {
                await fsp.chmod(outboundDir, 0o700);
            }
            assert.ok(
                h.logged.some(l => /Failed moving temporary outbound file/.test(l.a[1])),
                'the move failed'
            );
            assert.equal(
                parseInt(
                    h.db
                        .prepare(
                            `SELECT meta_value FROM message_meta WHERE message_id = ?
                            AND meta_category = 'System' AND meta_name = 'state_flags0';`
                        )
                        .get(message.messageId).meta_value,
                    10
                ),
                h.Message.StateFlags0.Exported,
                'flagged, so the old query would never select it again'
            );
            const minted = h.storedMsgId(message);

            const retry = await h.runExportScan(h.makeModule());
            assert.ok(!retry.err, retry.err && retry.err.message);
            assertEachOnce(await tally(), ['unmovable'], [U1, U2, U3], () => minted);
            assert.deepEqual(pendingRows(), []);
        });

        it('records every uplink as owed before any packet reaches outbound', async () => {
            const mod = h.makeModule();
            await h.addLocal({ subject: 'owed early' });
            const atDelivery = [];
            const deliver = mod.deliverEchoMailPackets;
            mod.deliverEchoMailPackets = function (dest, files, cb) {
                atDelivery.push(pendingRows());
                return deliver.call(this, dest, files, cb);
            };
            const result = await h.runExportScan(mod);
            assert.ok(!result.err, result.err && result.err.message);

            //  each uplink's row goes as soon as its own delivery is done
            assert.deepEqual(atDelivery, [
                [`owed early -> ${U1}`, `owed early -> ${U2}`, `owed early -> ${U3}`],
                [`owed early -> ${U2}`, `owed early -> ${U3}`],
                [`owed early -> ${U3}`],
            ]);
            assert.deepEqual(pendingRows(), []);
        });

        it('owes a message to an uplink that failed before it was even packetised', async () => {
            const mod = h.makeModule();
            //  U2's outbound directory cannot be created: a file is in the way
            const blocker = path.join(h.root, 'temp', 'not_a_dir');
            await fsp.writeFile(blocker, '');
            const create = mod.createEchoMailDestination;
            mod.createEchoMailDestination = function (uplink, ...rest) {
                const dest = create.call(this, uplink, ...rest);
                if (dest && U2 === uplink) {
                    dest.outgoingDir = path.join(blocker, 'outbound');
                }
                return dest;
            };
            const message = await h.addLocal({ subject: 'early failure' });
            await h.runExportScan(mod);
            assert.deepEqual(pendingRows(), [`early failure -> ${U2}`]);

            const retry = await h.runExportScan(h.makeModule());
            assert.ok(!retry.err, retry.err && retry.err.message);
            const minted = h.storedMsgId(message);
            assertEachOnce(await tally(), ['early failure'], [U1, U2, U3], () => minted);
        });

        it("does not hold up an uplink's new mail behind a message that always fails for it", async () => {
            const mod = h.makeModule();
            //  U2 can never take "poison": prepareMessage throws for it
            const prepare = mod.prepareMessage;
            mod.prepareMessage = function (message, exportOpts) {
                if ('poison' === message.subject && 702 === exportOpts.destAddress.node) {
                    throw new Error('cannot prepare for U2');
                }
                return prepare.call(this, message, exportOpts);
            };
            await h.addLocal({ subject: 'poison' });
            await h.runExportScan(mod);
            await h.runExportScan(mod);
            assert.deepEqual(pendingRows(), [`poison -> ${U2}`]);

            await h.addLocal({ subject: 'after poison' });
            await h.runExportScan(mod);
            const t = await tally();
            assertEachOnce(t, ['poison'], [U1, U3]);
            assertEachOnce(t, ['after poison'], [U1, U2, U3]);
            assert.equal(t[U2].poison, undefined);
            assert.deepEqual(pendingRows(), [`poison -> ${U2}`]);
        });

        //
        //  Owed rows for an uplink the area can no longer send to are kept (a
        //  config edit may be a mistake) and warned about on every scan.
        //
        const STRANDED = [
            {
                why: 'no longer in the area',
                uplinks: [U1, U2],
            },
            {
                //  same node, spelled differently: the rows name the old spelling
                why: 'respelled in the area',
                uplinks: [U1, U2, '1:218/703.0'],
            },
            {
                why: 'without a nodes entry',
                uplinks: [U1, U2, U3],
                nodes: n =>
                    Object.fromEntries(Object.entries(n).filter(([a]) => a !== U3)),
            },
        ];
        STRANDED.forEach(({ why, uplinks, nodes }) => {
            it(`warns about, and does not send, mail owed to an uplink ${why}`, async () => {
                const mod = h.makeModule();
                const down = uplinkDown(mod, U3);
                await h.addLocal({ subject: 'stranded one' });
                await h.addLocal({ subject: 'stranded two' });
                await h.runExportScan(mod);
                const owed = [`stranded one -> ${U3}`, `stranded two -> ${U3}`];
                assert.deepEqual(pendingRows(), owed);

                const savedUplinks = AREAS.local_a.uplinks;
                const savedConfig = mod.moduleConfig;
                AREAS.local_a.uplinks = uplinks;
                if (nodes) {
                    mod.moduleConfig = Object.assign({}, savedConfig, {
                        nodes: nodes(savedConfig.nodes),
                    });
                }
                down.down = false;
                const warned = [];
                try {
                    for (let scan = 0; scan < 2; ++scan) {
                        h.logged.length = 0;
                        await h.runExportScan(mod);
                        warned.push(
                            h.logged.filter(
                                l => 'warn' === l.level && /cannot send to/.test(l.a[1])
                            )
                        );
                    }
                } finally {
                    AREAS.local_a.uplinks = savedUplinks;
                    mod.moduleConfig = savedConfig;
                }

                for (const w of warned) {
                    assert.equal(w.length, 1, 'once per area per scan, every scan');
                    assert.deepEqual(w[0].a[0], {
                        areaTag: 'local_a',
                        uplinks: [U3],
                        messages: 2,
                    });
                }
                assert.deepEqual(Object.keys((await tally())[U3]), []);
                assert.equal(down.attempts, 1, 'never tried again');
                assert.deepEqual(pendingRows(), owed, 'kept, not dropped');
            });
        });

        it('retries the messages owed to an uplink in the order they were written', async () => {
            const mod = h.makeModule();
            const down = uplinkDown(mod, U2);
            await h.addLocal({ subject: 'order one' });
            await h.addLocal({ subject: 'order two' });
            await h.addLocal({ subject: 'order three' });
            await h.runExportScan(mod);
            assert.equal(pendingRows().length, 3);

            down.down = false;
            await h.runExportScan(mod);
            //  small enough to share one packet, so the order in it is the
            //  order they were given
            assert.deepEqual(
                (await delivered())[U2].map(m => m.subject),
                ['order one', 'order two', 'order three']
            );
        });

        //
        //  Three messages, a packet each. The packer writes each one by a
        //  different path -- A straight into the first packet, B held back and
        //  written as the second opens, C held back and written at the end --
        //  so each takes a turn as the packet that does not go out.
        //
        ['A', 'B', 'C'].forEach(lost => {
            it(`after a partial delivery, owes an uplink only the packet that did not go out (${lost})`, async () => {
                const mod = h.makeModule();
                const body = n =>
                    Array.from(
                        { length: 12 },
                        (_, i) => `Partial ${n}, line ${i}, padding to fill.`
                    ).join('\r\n');
                const all = ['A', 'B', 'C'].map(n => `partial ${n}`);
                for (const n of ['A', 'B', 'C']) {
                    await h.addLocal({ subject: `partial ${n}`, body: body(n) });
                }

                //  U2's packet carrying |lost| is moved but never referenced
                let failing = true;
                const append = mod.flowFileAppendRefs;
                mod.flowFileAppendRefs = function (flowFile, refs, directive, addr, cb) {
                    const carriesLost =
                        702 === addr.node &&
                        refs.some(r =>
                            fs
                                .readFileSync(r)
                                .toString('latin1')
                                .includes(`\x00partial ${lost}\x00`)
                        );
                    if (failing && carriesLost) {
                        return cb(new Error('flow file busy'));
                    }
                    return append.call(this, flowFile, refs, directive, addr, cb);
                };

                await h.runExportScan(mod);
                assert.deepEqual(
                    (await delivered())[U2].map(m => m.subject).sort(),
                    all.filter(s => s !== `partial ${lost}`),
                    'three packets; the other two went out'
                );
                assert.deepEqual(pendingRows(), [`partial ${lost} -> ${U2}`]);

                failing = false;
                await h.runExportScan(mod);
                assertEachOnce(await tally(), all, [U1, U2, U3]);
                assert.deepEqual(pendingRows(), []);
            });
        });

        it('does not flood an uplink added to the area later with its history', async () => {
            const saved = AREAS.local_a.uplinks;
            AREAS.local_a.uplinks = [U1, U2];
            try {
                await h.addLocal({ subject: 'before U3' });
                await h.runExportScan(h.makeModule());
            } finally {
                AREAS.local_a.uplinks = saved;
            }

            await h.addLocal({ subject: 'after U3' });
            const result = await h.runExportScan(h.makeModule());
            assert.ok(!result.err, result.err && result.err.message);
            const t = await tally();
            assertEachOnce(t, ['before U3', 'after U3'], [U1, U2]);
            assert.deepEqual(Object.keys(t[U3]), ['after U3']);
            assertEachOnce(t, ['after U3'], [U3]);
        });

        it('upgrades in place: the existing watermark is kept, and nothing already sent is sent again', async () => {
            //  as master leaves it: delivered and flagged mail below and above
            //  the watermark, and new mail above it
            const below = await makeMessage({
                subject: 'sent before upgrade',
                system: { state_flags0: '2' },
                meta: { FtnKludge: { MSGID: '1:218/700 000000c1' } },
            });
            await makeMessage({
                subject: 'sent live before upgrade',
                system: { state_flags0: '2' },
                meta: { FtnKludge: { MSGID: '1:218/700 000000c2' } },
            });
            const fresh = await h.addLocal({ subject: 'new after upgrade' });
            h.db
                .prepare(
                    `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
                VALUES ('ftn_bso', 'local_a', ?);`
                )
                .run(below.messageId);

            const result = await h.runExportScan(h.makeModule());
            assert.ok(!result.err, result.err && result.err.message);
            const t = await tally();
            for (const uplink of [U1, U2, U3]) {
                assert.deepEqual(Object.keys(t[uplink]), ['new after upgrade']);
            }
            assert.equal(scanId(), fresh.messageId);
            //  still the one per-area watermark; nothing else to migrate
            assert.deepEqual(
                h.db
                    .prepare('SELECT scan_toss, area_tag FROM message_area_last_scan;')
                    .all(),
                [{ scan_toss: 'ftn_bso', area_tag: 'local_a' }]
            );
        });
    });

    // ─── live export, then the scan ──────────────────────────────────────────

    describe('live export followed by the scan', () => {
        it('sends nothing twice after a live export that succeeded', async () => {
            const mod = h.makeModule();
            const message = await h.addLocal({ subject: 'live ok' });
            const live = await h.runLiveExport(mod, message);
            assert.ok(!live.err, live.err && live.err.message);
            assert.deepEqual(pendingRows(), []);

            const scan = await h.runExportScan(mod);
            assert.ok(!scan.err, scan.err && scan.err.message);
            assertEachOnce(await tally(), ['live ok'], [U1, U2, U3]);
        });

        it('retries, in the scan, only the uplink a live export failed for', async () => {
            const mod = h.makeModule();
            const down = uplinkDown(mod, U1);
            const message = await h.addLocal({ subject: 'live partial' });
            const live = await h.runLiveExport(mod, message);
            assert.ok(live.err, 'the live export reports the failure');
            assert.deepEqual(pendingRows(), [`live partial -> ${U1}`]);
            const minted = h.storedMsgId(message);
            assert.equal(minted.length, 1);

            down.down = false;
            const scan = await h.runExportScan(mod);
            assert.ok(!scan.err, scan.err && scan.err.message);
            assertEachOnce(await tally(), ['live partial'], [U1, U2, U3], () => minted);
            assert.deepEqual(pendingRows(), []);
        });
    });

    // ─── relay is not affected ───────────────────────────────────────────────

    it('leaves relay to its own per-uplink watermarks: a failed relay owes nothing to the export scan', async () => {
        const mod = h.makeModule();
        //  first sight of the area seeds relay's watermarks
        await h.addImported({ areaTag: 'relay_a', msgId: '1:218/701 0000d001' });
        await h.runRelay(mod);

        uplinkDown(mod, U2);
        await h.addImported({
            areaTag: 'relay_a',
            seenBy: '218/701',
            msgId: '1:218/701 0000d002',
            subject: 'relayed while U2 is down',
        });
        await h.runRelay(mod);
        assert.ok(
            h.logged.some(l => /EchoMail relay incomplete/.test(l.a[1])),
            'the relay to U2 failed'
        );
        assert.deepEqual(pendingRows(), []);
    });
});

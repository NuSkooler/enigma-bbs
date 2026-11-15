'use strict';

//
//  EchoMail export scan: which messages it exports, and its retry of an
//  uplink that failed (issue #1026).
//
//  The scan selects the messages in an area above its watermark that carry no
//  System/state_flags0 row at all. The exporter writes that row (Exported,
//  with the MSGID) as soon as a message is handed to its first destination,
//  before anything is delivered. So once one uplink had taken a message, an
//  uplink that failed -- a move into outbound, a busy flow file, a second
//  uplink that was down -- never saw it again, although the log said "will
//  retry".
//
//  The first part pins which kinds of message the scan exports. That set is
//  master's, unchanged: other tossers write bits into the same state_flags0,
//  and changing who counts as "ours to export" is a policy decision of its
//  own.
//

const { strict: assert } = require('assert');
const fsp = require('fs/promises');
const path = require('path');

const { createHarness, U1, U2, U3 } = require('./ftn_export_harness.js');

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

    function scanId(scanToss = 'ftn_bso', areaTag = 'local_a') {
        const row = h.db
            .prepare(
                'SELECT message_id FROM message_area_last_scan WHERE scan_toss = ? AND area_tag = ?;'
            )
            .get(scanToss, areaTag);
        return row ? row.message_id : undefined;
    }

    // ─── which messages the scan exports ─────────────────────────────────────

    describe('eligibility (unchanged from master)', () => {
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
        //  * a local post the ActivityPub tosser exported first: Exported (2),
        //    written raw, with ActivityPub ids and no MSGID
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

        const EXPORTED = ['elig ap imported', 'elig local post', 'elig qwk reply'];

        it('exports exactly the messages that carry no state flags, to every uplink', async () => {
            const m = await addOneOfEach();
            const result = await h.runExportScan(h.makeModule());
            assert.ok(!result.err, result.err && result.err.message);

            assert.deepEqual(subjectsOf(await delivered()), {
                [U1]: EXPORTED,
                [U2]: EXPORTED,
                [U3]: EXPORTED,
            });
            //  the watermark moves to the last message exported
            assert.equal(scanId(), m.apImported.messageId);
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
            h.db.prepare(
                `INSERT INTO message_area_last_scan (scan_toss, area_tag, message_id)
                VALUES ('ftn_bso', 'local_a', ?);`
            ).run(exportedLive.messageId - 1);

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
});

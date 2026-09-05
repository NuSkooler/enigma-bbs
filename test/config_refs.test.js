'use strict';

const { strict: assert } = require('assert');
const _ = require('lodash');

const { validateReferences } = require('../core/config/refs');
const { IssueCodes, Severity, describeIssue } = require('../core/config/issue');
const DefaultConfig = require('../core/config_default');

//
//  A configuration carrying the three-way coupling the docs describe at
//  docs/_docs/messageareas/binkp.md:272-285: a TIC area pointing at a file
//  area, which points at a storage tag. Break any one link and nothing
//  complains -- the file simply never lands.
//
const soundConfig = () =>
    _.merge(DefaultConfig(), {
        messageConferences: {
            local: { name: 'Local', areas: { general: { name: 'General' } } },
        },
        messageNetworks: {
            ftn: {
                networks: { agoranet: { localAddress: '46:1/100' } },
                areas: {
                    agn_general: { tag: 'AGN_GEN', network: 'agoranet', uplinks: [] },
                },
            },
        },
        fileBase: {
            storageTags: { nodelists: '/tmp/nodelists' },
            areas: { nodelists: { name: 'Nodelists', storageTags: ['nodelists'] } },
        },
        scannerTossers: {
            ftn_bso: {
                defaultNetwork: 'agoranet',
                ticAreas: {
                    fidonet_nodelist: {
                        areaTag: 'nodelists',
                        storageTag: 'nodelists',
                        network: 'agoranet',
                    },
                },
                netMail: {
                    routes: { '46:*': { address: '46:1/100', network: 'agoranet' } },
                },
            },
        },
        contentServers: {
            nntp: { publicMessageConferences: { local: ['general'] } },
        },
    });

const withChange = mutate => {
    const config = soundConfig();
    mutate(config);
    return validateReferences(config);
};

const onlyIssue = issues => {
    assert.equal(issues.length, 1, `expected one issue, got ${issues.length}`);
    return issues[0];
};

// ─── Nothing to say about a sound configuration ──────────────────────────────

describe('config cross-references: a sound configuration', () => {
    it('produces no findings', () => {
        assert.deepEqual(validateReferences(soundConfig()), []);
    });

    it('produces no findings for the shipped defaults alone', () => {
        assert.deepEqual(validateReferences(DefaultConfig()), []);
    });

    it('does not fall over on an empty or absent configuration', () => {
        assert.deepEqual(validateReferences({}), []);
        assert.deepEqual(validateReferences(undefined), []);
    });
});

// ─── File base ───────────────────────────────────────────────────────────────

describe('config cross-references: file base', () => {
    it('catches a storage tag that names nothing', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.fileBase.areas.nodelists.storageTags = ['nodelist'];
            })
        );

        assert.equal(issue.code, IssueCodes.UnresolvedRef);
        assert.equal(issue.severity, Severity.Error);
        assert.equal(issue.path, 'fileBase.areas.nodelists.storageTags[0]');
        assert.equal(
            describeIssue(issue).message,
            'storage tag "nodelist" is not defined in fileBase.storageTags -- did you mean "nodelists"?'
        );
    });

    it('offers the operator their own tags, not the ones ENiGMA ships', () => {
        //  sys_msg_attach and sys_temp_download are internal; nobody means to
        //  point a file echo at them, so they are noise in a suggestion. They
        //  remain perfectly legal to reference -- see below.
        const issue = onlyIssue(
            withChange(c => {
                c.fileBase.areas.nodelists.storageTags = ['wildly_different'];
            })
        );

        assert.deepEqual(issue.candidates, ['nodelists']);
        assert.equal(issue.suggestion, undefined);
        assert.ok(describeIssue(issue).message.endsWith('known: nodelists'));
    });

    it('still accepts a reference to an internal tag', () => {
        assert.deepEqual(
            withChange(c => {
                c.fileBase.areas.nodelists.storageTags = ['sys_temp_download'];
            }),
            []
        );
    });

    it('falls back to the built-ins when the operator has none of their own', () => {
        //  an empty "known:" would be worse than showing what does exist
        const issues = withChange(c => {
            //  removing the only operator tag also orphans the TIC area that
            //  names it, so pick out the one this test is about
            delete c.fileBase.storageTags.nodelists;
            c.fileBase.areas.nodelists.storageTags = ['wildly_different'];
        });

        const issue = issues.find(
            i => 'fileBase.areas.nodelists.storageTags[0]' === i.path
        );

        assert.ok(issue, 'expected the orphaned storage tag to be reported');
        assert.deepEqual(issue.candidates, ['sys_msg_attach', 'sys_temp_download']);
    });

    it('accepts storageTags given as a bare string', () => {
        //  core/file_base_area.js:247-249 accepts either
        assert.deepEqual(
            withChange(c => {
                c.fileBase.areas.nodelists.storageTags = 'nodelists';
            }),
            []
        );
    });

    it('leaves a missing storageTags alone, since that is a shape problem', () => {
        assert.deepEqual(
            withChange(c => {
                delete c.fileBase.areas.nodelists.storageTags;
            }),
            []
        );
    });
});

// ─── TIC areas ───────────────────────────────────────────────────────────────

describe('config cross-references: TIC areas', () => {
    it('catches an areaTag that names no file area', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist.areaTag = 'nodelist';
            })
        );
        assert.equal(
            issue.path,
            'scannerTossers.ftn_bso.ticAreas.fidonet_nodelist.areaTag'
        );
        assert.equal(issue.refKind, 'file area');
    });

    it('catches a storageTag that names nothing', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist.storageTag = 'nope';
            })
        );
        assert.equal(issue.refKind, 'storage tag');
    });

    it('catches a network that is not configured', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist.network = 'agoranett';
            })
        );
        assert.equal(issue.refKind, 'FTN network');
    });

    it('understands the bare string shorthand for an entry', () => {
        //  ftn_bso.js:2822-2830 accepts a string as shorthand for areaTag
        assert.deepEqual(
            withChange(c => {
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist = 'nodelists';
            }),
            []
        );

        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist = 'nodelist';
            })
        );
        assert.equal(issue.refKind, 'file area');
    });
});

// ─── Networks ────────────────────────────────────────────────────────────────

describe('config cross-references: networks', () => {
    it('catches an echo naming a network that is not configured', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.messageNetworks.ftn.areas.agn_general.network = 'agoranett';
            })
        );
        assert.equal(issue.path, 'messageNetworks.ftn.areas.agn_general.network');
    });

    it('catches a NetMail route naming a network that is not configured', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.netMail.routes['46:*'].network = 'nope';
            })
        );
        assert.equal(issue.path, 'scannerTossers.ftn_bso.netMail.routes.46:*.network');
    });

    it('matches network names without regard to case', () => {
        //  canonicalNetworkName() lowercases both sides, so this really is
        //  the same network and must not be reported
        assert.deepEqual(
            withChange(c => {
                c.messageNetworks.ftn.areas.agn_general.network = 'AgoraNet';
                c.scannerTossers.ftn_bso.ticAreas.fidonet_nodelist.network = 'AGORANET';
            }),
            []
        );
    });

    it('catches a defaultNetwork that names nothing, via bso_util', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.scannerTossers.ftn_bso.defaultNetwork = 'agoranett';
            })
        );
        assert.equal(issue.path, 'scannerTossers.ftn_bso.defaultNetwork');
        assert.equal(issue.code, IssueCodes.UnresolvedRef);
    });

    it('catches a network whose zone cannot be resolved, via bso_util', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.messageNetworks.ftn.networks.agoranet.localAddress = 'not an address';
            })
        );
        assert.equal(issue.path, 'messageNetworks.ftn.networks.agoranet');
    });

    it('catches a network named "outbound", which collides with the spool', () => {
        const issues = withChange(c => {
            c.messageNetworks.ftn.networks.outbound = { localAddress: '46:1/101' };
        });

        const collision = issues.find(i => IssueCodes.InvalidEnum === i.code);
        assert.ok(collision, 'expected the reserved name to be reported');
        assert.equal(collision.path, 'messageNetworks.ftn.networks.outbound');
    });
});

// ─── NNTP public conferences ─────────────────────────────────────────────────

describe('config cross-references: public NNTP conferences', () => {
    it('catches a conference tag that does not exist', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.contentServers.nntp.publicMessageConferences = { locol: ['general'] };
            })
        );
        assert.equal(issue.refKind, 'message conference');
        assert.equal(issue.path, 'contentServers.nntp.publicMessageConferences.locol');
    });

    it('catches an area tag that is not in that conference', () => {
        const issue = onlyIssue(
            withChange(c => {
                c.contentServers.nntp.publicMessageConferences.local = ['generel'];
            })
        );
        assert.equal(issue.refKind, 'message area');
        assert.equal(issue.path, 'contentServers.nntp.publicMessageConferences.local[0]');
    });
});

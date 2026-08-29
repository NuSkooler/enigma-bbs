/* jslint node: true */
'use strict';

//  ENiGMA½
const Address = require('./ftn_address.js');
const Errors = require('./enig_error.js').Errors;
const EnigAssert = require('./enigma_assert.js');

//  deps
const fs = require('graceful-fs');
const CRC32 = require('./crc.js').CRC32;
const _ = require('lodash');
const async = require('async');
const paths = require('path');
const crypto = require('crypto');

//
//  Class to read and hold information from a TIC file
//
//  * FTS-5006.001 @ http://www.filegate.net/ftsc/FTS-5006.001
//  * FSP-1039.001 @ http://ftsc.org/docs/old/fsp-1039.001
//  * FSC-0087.001 @ http://ftsc.org/docs/fsc-0087.001
//
module.exports = class TicFileInfo {
    constructor() {
        this.entries = new Map();
    }

    static get requiredFields() {
        return [
            'Area',
            'Origin',
            'From',
            'File',
            'Crc',
            //  :TODO: validate this:
            //'Path', 'Seenby'  //  these two are questionable; some systems don't send them?
        ];
    }

    //
    //  Reason codes set on validation failures so callers can tell a TIC that is
    //  merely *early* -- its payload has not landed yet, or is still landing --
    //  from one that is genuinely bad.
    //
    //  This mirrors htick, the de facto reference implementation: processTic()
    //  returns TIC_NotRecvd both when the announced file is absent ("has not been
    //  received, waiting") and when the CRC/size disagree, and processDir() then
    //  leaves the TIC in the inbound to be retried on a later pass.
    //
    static get ReasonCodes() {
        return {
            //  announced file is not in the inbound at all (yet)
            PayloadPending: 'TIC_PAYLOAD_PENDING',
            //  present, but shorter than the announced Size -- still arriving
            PayloadIncomplete: 'TIC_PAYLOAD_INCOMPLETE',
            //  present and complete-looking, but Size/CRC-32/SHA-256 disagree
            PayloadMismatch: 'TIC_PAYLOAD_MISMATCH',
        };
    }

    //
    //  True when |err| means "the announced file is not (yet) here in one piece".
    //  Such a TIC must be held rather than rejected: the payload routinely arrives
    //  in a *later* mailer session than its announcement, and a mailer that writes
    //  straight into the inbound (binkd and friends) can be observed mid-transfer.
    //
    static isPayloadPendingError(err) {
        if (!err) {
            return false;
        }

        //  a bare fs error can still reach us if the payload is unlinked between
        //  resolution and the read
        if ('ENOENT' === err.code) {
            return true;
        }

        const codes = TicFileInfo.ReasonCodes;
        return [
            codes.PayloadPending,
            codes.PayloadIncomplete,
            codes.PayloadMismatch,
        ].includes(err.reasonCode);
    }

    get(key) {
        return this.entries.get(key.toLowerCase());
    }

    getAsString(key, joinWith) {
        const value = this.get(key);
        if (value) {
            //
            //  We call toString() on values to ensure numbers, addresses, etc. are converted
            //
            joinWith = joinWith || '';
            if (Array.isArray(value)) {
                return value.map(v => v.toString()).join(joinWith);
            }

            return value.toString();
        }
    }

    //
    //  Path to the announced payload, alongside the TIC itself.
    //
    //  Returns undefined -- never throws -- when there is no usable "File" field:
    //  a TIC missing it still reaches the error paths in the scanner/tosser, and
    //  those log and clean up using this property.
    //
    //  Once resolveFilePath() has run this is the *actual* path on disk, which may
    //  differ from the announcement in case only. See resolveFilePath().
    //
    get filePath() {
        if (this.resolvedFilePath) {
            return this.resolvedFilePath;
        }

        const fileName = this.getAsString('File');
        if (!fileName || !this.path) {
            return undefined;
        }

        return paths.join(paths.dirname(this.path), fileName);
    }

    //
    //  The name the file is stored under locally, preferring the long form.
    //
    //  "Lfile"/"Fullname" carry a *filename*, never a path, but nothing in the
    //  format stops a peer from sending one anyway -- and the scanner/tosser
    //  feeds this straight into paths.join(areaStorageDir, ...), where a
    //  traversal writes the payload outside the file base entirely. validate()
    //  rejects such a TIC outright; discarding unsafe candidates here as well
    //  keeps the getter safe for any other caller.
    //
    get longFileName() {
        return [
            this.getAsString('Lfile'),
            this.getAsString('Fullname'),
            this.getAsString('File'),
        ].find(name => TicFileInfo.isSafeFileName(name));
    }

    hasRequiredFields() {
        const req = TicFileInfo.requiredFields;
        return req.every(f => this.get(f));
    }

    //  A "File" value we are willing to look for: a bare name, no traversal.
    static isSafeFileName(fileName) {
        return !(
            !fileName ||
            fileName.includes('/') ||
            fileName.includes('\\') ||
            fileName.includes('..') ||
            paths.isAbsolute(fileName)
        );
    }

    //
    //  Locate the announced "File" on disk, next to the TIC itself, and remember
    //  it as |resolvedFilePath|.
    //
    //  FTS-5006 names the file in DOS 8.3 form and says nothing about case. In
    //  practice the announcement and the delivered file routinely disagree -- a
    //  TIC saying NODELIST.Z34 against a nodelist.z34 on disk is ordinary -- and
    //  on a case-sensitive filesystem the literal name simply is not there. htick
    //  normalizes this with adaptcase(); we do the same with a case-insensitive
    //  scan of the TIC's own directory when the exact name misses.
    //
    //  Only basenames are ever compared, so a match is necessarily a sibling of
    //  the TIC; the "File" field is re-checked for traversal here so this is safe
    //  to call on its own.
    //
    resolveFilePath(cb) {
        const fileName = this.getAsString('File');

        if (!TicFileInfo.isSafeFileName(fileName) || !this.path) {
            return cb(Errors.Invalid('Invalid or unsafe File field in TIC'));
        }

        const pending = () =>
            Errors.DoesNotExist(
                `TIC payload "${fileName}" has not been received`,
                TicFileInfo.ReasonCodes.PayloadPending
            );

        const dir = paths.dirname(this.path);
        const exactPath = paths.join(dir, fileName);

        fs.stat(exactPath, (err, stats) => {
            if (!err && stats.isFile()) {
                this.resolvedFilePath = exactPath;
                return cb(null, exactPath);
            }

            fs.readdir(dir, (err, files) => {
                if (err) {
                    return cb(pending());
                }

                //  sorted so a directory holding several case variants resolves
                //  the same way on every pass
                const wanted = fileName.toLowerCase();
                const candidates = files.filter(f => f.toLowerCase() === wanted).sort();

                async.detectSeries(
                    candidates,
                    (candidate, nextCandidate) => {
                        fs.stat(paths.join(dir, candidate), (err, stats) => {
                            return nextCandidate(null, !err && stats.isFile());
                        });
                    },
                    (err, match) => {
                        if (err || !match) {
                            return cb(pending());
                        }

                        this.resolvedFilePath = paths.join(dir, match);
                        return cb(null, this.resolvedFilePath);
                    }
                );
            });
        });
    }

    validate(config, cb) {
        //  config.nodes
        //  config.defaultPassword (optional)
        //  config.localAreaTags
        EnigAssert(config.nodes && config.localAreaTags);

        const self = this;

        async.waterfall(
            [
                function initial(callback) {
                    if (!self.hasRequiredFields()) {
                        return callback(
                            Errors.Invalid('One or more required fields missing from TIC')
                        );
                    }

                    //
                    //  Reject path traversal in any field that names the payload.
                    //  "File" locates it in the inbound; "Lfile"/"Fullname" name
                    //  it in file base storage and are just as dangerous -- they
                    //  reach paths.join(areaStorageDir, ...) unchanged.
                    //
                    if (!TicFileInfo.isSafeFileName(self.getAsString('File'))) {
                        return callback(
                            Errors.Invalid('Invalid or unsafe File field in TIC')
                        );
                    }

                    //  ...these two are optional, so only checked when present
                    const unsafeLongName = ['Lfile', 'Fullname'].find(field => {
                        const value = self.getAsString(field);
                        return undefined !== value && !TicFileInfo.isSafeFileName(value);
                    });

                    if (unsafeLongName) {
                        return callback(
                            Errors.Invalid(
                                `Invalid or unsafe ${unsafeLongName} field in TIC`
                            )
                        );
                    }

                    const area = self.getAsString('Area').toUpperCase();

                    const localInfo = {
                        areaTag: config.localAreaTags.find(
                            areaTag => areaTag.toUpperCase() === area
                        ),
                    };

                    if (!localInfo.areaTag) {
                        return callback(
                            Errors.Invalid(`No local area for "Area" of ${area}`)
                        );
                    }

                    const from = Address.fromString(self.getAsString('From'));
                    if (!from.isValid()) {
                        return callback(
                            Errors.Invalid(
                                `Invalid "From" address: ${self.getAsString('From')}`
                            )
                        );
                    }

                    //  note that our config may have wildcards, such as "80:774/*"
                    localInfo.node = Object.keys(config.nodes).find(nodeAddrWildcard =>
                        from.isPatternMatch(nodeAddrWildcard)
                    );

                    if (!localInfo.node) {
                        return callback(Errors.Invalid('TIC is not from a known node'));
                    }

                    //  if we require a password, "PW" must match
                    const passActual =
                        _.get(config.nodes, [localInfo.node, 'tic', 'password']) ||
                        config.defaultPassword;
                    if (!passActual) {
                        return callback(null, localInfo); //  no pw validation
                    }

                    //  FTN passwords are compared without regard to case: htick
                    //  uses stricmp() here, and our own packet password check in
                    //  ftn_bso.js already upper-cases both sides. A TIC rejected
                    //  purely over case looks identical to a lost file.
                    //
                    //  String(): an unquoted password in config.hjson arrives as
                    //  a number, and must not throw here.
                    const passTic = (self.getAsString('Pw') || '').toUpperCase();
                    if (passTic !== String(passActual).toUpperCase()) {
                        return callback(Errors.Invalid('Bad TIC password'));
                    }

                    return callback(null, localInfo);
                },
                function resolvePayload(localInfo, callback) {
                    //  Find the announced file before hashing it, so "not here
                    //  yet" is reported as such rather than as a read failure --
                    //  and so a case-mismatched delivery still resolves.
                    self.resolveFilePath(err => {
                        return callback(err, localInfo);
                    });
                },
                function checksumAndSize(localInfo, callback) {
                    const crcTic = self.get('Crc');
                    const stream = fs.createReadStream(self.filePath);
                    const crc = new CRC32();
                    let sizeActual = 0;

                    let sha256Tic = self.getAsString('Sha256');
                    let sha256;
                    if (sha256Tic) {
                        sha256Tic = sha256Tic.toLowerCase();
                        sha256 = crypto.createHash('sha256');
                    }

                    stream.on('data', data => {
                        sizeActual += data.length;

                        //  sha256 if possible, else crc32
                        if (sha256) {
                            sha256.update(data);
                        } else {
                            crc.update(data);
                        }
                    });

                    stream.on('end', () => {
                        const codes = TicFileInfo.ReasonCodes;

                        //
                        //  Size first, when the TIC carries one. A file still
                        //  being written is short, and saying so is far more
                        //  useful than the checksum mismatch it also produces.
                        //
                        const sizeTic = self.get('Size');
                        if (sizeTic !== undefined && sizeTic !== sizeActual) {
                            return callback(
                                Errors.Invalid(
                                    `TIC "Size" of ${sizeTic} does not match actual size of ${sizeActual}`,
                                    sizeActual < sizeTic
                                        ? codes.PayloadIncomplete
                                        : codes.PayloadMismatch
                                )
                            );
                        }

                        //
                        //  A checksum failure is reported as a mismatch rather
                        //  than as corruption: without a Size to confirm the file
                        //  is whole we cannot tell a bad file from one still in
                        //  flight, and htick likewise re-queues on bad CRC. The
                        //  caller holds it, then rejects once the hold expires.
                        //
                        if (sha256) {
                            const sha256Actual = sha256.digest('hex');
                            if (sha256Tic != sha256Actual) {
                                return callback(
                                    Errors.Invalid(
                                        `TIC "Sha256" of ${sha256Tic} does not match actual SHA-256 of ${sha256Actual}`,
                                        codes.PayloadMismatch
                                    )
                                );
                            }

                            localInfo.sha256 = sha256Actual;
                        } else {
                            const crcActual = crc.finalize();
                            if (crcActual !== crcTic) {
                                return callback(
                                    Errors.Invalid(
                                        `TIC "Crc" of ${crcTic} does not match actual CRC-32 of ${crcActual}`,
                                        codes.PayloadMismatch
                                    )
                                );
                            }
                            localInfo.crc32 = crcActual;
                        }

                        return callback(null, localInfo);
                    });

                    stream.on('error', err => {
                        return callback(err);
                    });
                },
            ],
            (err, localInfo) => {
                return cb(err, localInfo);
            }
        );
    }

    isToAddress(address, allowNonExplicit) {
        //
        //  FSP-1039.001:
        //  "This keyword specifies the FTN address of the system where to
        //  send the file to be distributed and the accompanying TIC file.
        //  Some File processors (Allfix) only insert a line with this
        //  keyword when the file and the associated TIC file are to be
        //  file routed through a third system instead of being processed
        //  by a file processor on that system. Others always insert it.
        //  Note that the To keyword may cause problems when the TIC file
        //  is processed by software that does not recognize it and
        //  passes the line "as is" to other systems.
        //
        //  Example:  To 292/854
        //
        //  This is an optional keyword."
        //
        const to = this.get('To');

        if (!to) {
            return allowNonExplicit;
        }

        return address.isEqual(to);
    }

    static createFromFile(path, cb) {
        fs.readFile(path, 'utf8', (err, ticData) => {
            if (err) {
                return cb(err);
            }

            const ticFileInfo = new TicFileInfo();
            ticFileInfo.path = path;

            //
            //  Lines in a TIC file should be separated by CRLF (DOS)
            //  may be separated by LF (UNIX)
            //
            const lines = ticData.split(/\r\n|\n/g);
            let keyEnd;
            let key;
            let value;
            let entry;

            lines.forEach(line => {
                keyEnd = line.search(/\s/);

                if (keyEnd < 0) {
                    keyEnd = line.length;
                }

                key = line.substr(0, keyEnd).toLowerCase();

                if (0 === key.length) {
                    return;
                }

                value = line.substr(keyEnd + 1);

                //  don't trim Ldesc; may mess with FILE_ID.DIZ type descriptions
                if ('ldesc' !== key) {
                    value = value.trim();
                }

                //  convert well known keys to a more reasonable format
                switch (key) {
                    case 'origin':
                    case 'from':
                    case 'seenby':
                    case 'to':
                        value = Address.fromString(value);
                        break;

                    case 'crc':
                        value = parseInt(value, 16);
                        break;

                    case 'size':
                        value = parseInt(value, 10);
                        break;

                    default:
                        break;
                }

                entry = ticFileInfo.entries.get(key);

                if (entry) {
                    if (!Array.isArray(entry)) {
                        entry = [entry];
                        ticFileInfo.entries.set(key, entry);
                    }
                    entry.push(value);
                } else {
                    ticFileInfo.entries.set(key, value);
                }
            });

            return cb(null, ticFileInfo);
        });
    }
};

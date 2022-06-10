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

    get filePath() {
        return paths.join(paths.dirname(this.path), this.getAsString('File'));
    }

    get longFileName() {
        return (
            this.getAsString('Lfile') ||
            this.getAsString('Fullname') ||
            this.getAsString('File')
        );
    }

    hasRequiredFields() {
        const req = TicFileInfo.requiredFields;
        return req.every(f => this.get(f));
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

                    const passTic = self.getAsString('Pw');
                    if (passTic !== passActual) {
                        return callback(Errors.Invalid('Bad TIC password'));
                    }

                    return callback(null, localInfo);
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
                        //  again, use sha256 if possible
                        if (sha256) {
                            const sha256Actual = sha256.digest('hex');
                            if (sha256Tic != sha256Actual) {
                                return callback(
                                    Errors.Invalid(
                                        `TIC "Sha256" of ${sha256Tic} does not match actual SHA-256 of ${sha256Actual}`
                                    )
                                );
                            }

                            localInfo.sha256 = sha256Actual;
                        } else {
                            const crcActual = crc.finalize();
                            if (crcActual !== crcTic) {
                                return callback(
                                    Errors.Invalid(
                                        `TIC "Crc" of ${crcTic} does not match actual CRC-32 of ${crcActual}`
                                    )
                                );
                            }
                            localInfo.crc32 = crcActual;
                        }

                        const sizeTic = self.get('Size');
                        if (_.isUndefined(sizeTic)) {
                            return callback(null, localInfo);
                        }

                        if (sizeTic !== sizeActual) {
                            return callback(
                                Errors.Invalid(
                                    `TIC "Size" of ${sizeTic} does not match actual size of ${sizeActual}`
                                )
                            );
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

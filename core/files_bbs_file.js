/* jslint node: true */
'use strict';

const { Errors }    = require('./enig_error.js');

//  deps
const fs            = require('graceful-fs');
const iconv         = require('iconv-lite');
const moment        = require('moment');

module.exports = class FilesBBSFile {
    constructor() {
        this.entries = new Map();
    }

    get(fileName) {
        return this.entries.get(fileName);
    }

    getDescription(fileName) {
        const entry = this.get(fileName);
        if(entry) {
            return entry.desc;
        }
    }

    static createFromFile(path, cb) {
        fs.readFile(path, (err, descData) => {
            if(err) {
                return cb(err);
            }

            //  :TODO: encoding should be default to CP437, but allowed to change - ie for Amiga/etc.
            const lines = iconv.decode(descData, 'cp437').split(/\r?\n/g);
            const filesBbs = new FilesBBSFile();

            //
            //  Contrary to popular belief, there is not a FILES.BBS standard. Instead,
            //  many formats have been used over the years. We'll try to support as much
            //  as we can within reason.
            //
            //  Resources:
            //  - Great info from Mystic @ http://wiki.mysticbbs.com/doku.php?id=mutil_import_files.bbs
            //  - https://alt.bbs.synchronet.narkive.com/I6Vrxq6q/format-of-files-bbs
            //
            //  Example files:
            //  - https://github.com/NuSkooler/ansi-bbs/tree/master/ancient_formats/files_bbs
            //
            const detectDecoder = () => {
                //
                //  Try to figure out which decoder to use
                //
                const decoders = [
                    {
                        //  I've been told this is what Syncrhonet uses
                        tester  : /^([^ ]{1,12})\s{1,11}([0-3][0-9]\/[0-3][0-9]\/[1789][0-9]) ([^\r\n]+)$/,
                        extract : function() {
                            for(let i = 0; i < lines.length; ++i) {
                                let line = lines[i];
                                const hdr = line.match(this.tester);
                                if(!hdr) {
                                    continue;
                                }
                                const long = [];
                                for(let j = i + 1; j < lines.length; ++j) {
                                    line = lines[j];
                                    if(!line.startsWith(' ')) {
                                        break;
                                    }
                                    long.push(line.trim());
                                    ++i;
                                }
                                const desc      = long.join('\r\n') || hdr[3] || '';
                                const fileName  = hdr[1];
                                const timestamp = moment(hdr[2], 'MM/DD/YY');

                                filesBbs.entries.set(fileName, { timestamp, desc } );
                            }
                        }
                    },

                    {
                        //
                        //  Aminet Amiga CDROM, March 1994.  Walnut Creek CDROM.
                        //  CP/M CDROM, Sep. 1994.  Walnut Creek CDROM.
                        //  ...and many others. Basically: <8.3 filename> <description>
                        //
                        //  May contain headers, but we'll just skip 'em.
                        //
                        tester  : /^([^ ]{1,12})\s{1,11}([^\r\n]+)$/,
                        extract : function() {
                            lines.forEach(line => {
                                const hdr = line.match(this.tester);
                                if(!hdr) {
                                    return; //  forEach
                                }

                                const fileName  = hdr[1].trim();
                                const desc      = hdr[2].trim();

                                if(desc) {
                                    filesBbs.entries.set(fileName, { desc } );
                                }
                            });
                        }
                    },

                    {
                        //  Found on AMINET CD's & similar
                        tester  : /^(.{1,22}) ([0-9]+)K ([^\r\n]+)$/,
                        extract : function() {
                            lines.forEach(line => {
                                const hdr = line.match(this.tester);
                                if(!hdr) {
                                    return; //  forEach
                                }

                                const fileName  = hdr[1].trim();
                                let size        = parseInt(hdr[2]);
                                const desc      = hdr[3].trim();

                                if(!isNaN(size)) {
                                    size *= 1024;   //  K->bytes.
                                }

                                if(desc) {  //  omit empty entries
                                    filesBbs.entries.set(fileName, { size, desc } );
                                }
                            });
                        }
                    },
                ];

                const decoder = decoders.find(d => {
                    return lines
                        .slice(0, 10)   //  10 lines in should be enough to detect - skipping headers/etc.
                        .some(l => d.tester.test(l));
                });

                return decoder;
            };

            const decoder = detectDecoder();
            if(!decoder) {
                return cb(Errors.Invalid('Invalid or unrecognized FILES.BBS format'));
            }

            decoder.extract(decoder);

            return cb(
                filesBbs.entries.size > 0 ? null : Errors.Invalid('Invalid or unrecognized FILES.BBS format'),
                filesBbs
            );
        });
    }


};

/* jslint node: true */
'use strict';

//  ENiGMA½
const Address = require('./ftn_address.js');

//  deps
const _ = require('lodash');

//
//  Build an outgoing TIC file for one downlink.
//
//  * FTS-5006.001 @ http://ftsc.org/docs/fts-5006.001  (the file format)
//  * FSC-0087.001 @ http://ftsc.org/docs/fsc-0087.001  (forwarding behaviour)
//
//  This is the counterpart to TicFileInfo, which reads. The split matters: a
//  reader should be liberal and a writer must not be, and the two have almost
//  no logic in common.
//
//  The shape follows Synchronet's tickit.js rather than htick: everything we do
//  not regenerate is passed through as the *raw line we received*, in the order
//  we received it. That is what both specs ask for --
//
//      "New implementations should be tolerant of unknown keywords. If a line
//       with an unknown keyword is found in an incoming TIC file, the preferred
//       way of dealing with it is to pass the line 'as is' to outgoing TIC
//       files."                                            -- FTS-5006 2.2
//
//      "Keywords not understood are to be passed-though."  -- FSC-0087
//
//  -- and it also preserves the grouping and relative order FSC-0087 requires
//  for Desc, Ldesc and App without needing to model any of them.
//
module.exports = class TicFileWriter {
    //
    //  Keywords we always generate ourselves, so an inbound line for one of
    //  these is never passed through.
    //
    //  FSC-0087 marks most of these '^' ("should not be passed-through"). Two
    //  are ours rather than the spec's:
    //
    //    crc     -- regenerated from the *computed* checksum. When an inbound
    //               TIC carries Sha256, TicFileInfo verifies that and never
    //               looks at the announced Crc, so passing that value on would
    //               have us vouch for a number nothing checked. Every htick and
    //               Mystic downlink verifies Crc, so a wrong one means the file
    //               is rejected with our name on the From line.
    //    magic   -- FSC-0087: "This is NOT passed though when forwarding,
    //               unless the MAGIC name is the same on the forwarding site."
    //               We do not maintain magic names, so it is dropped.
    //
    static get regeneratedKeywords() {
        return new Set([
            'created',
            'crc',
            'from',
            'to',
            'pw',
            'path',
            'seenby',
            'magic',
            'receiptrequest',
        ]);
    }

    //
    //  Keywords defined by FSC-0087 / FTS-5006. Everything else is "unknown"
    //  and is passed through unless the link is in FSC-87 subset mode.
    //
    //  htick has exactly this switch per link (FileFixFSC87Subset). Its default
    //  is the permissive one, and its documentation tells sysops to leave it
    //  there -- but with it off, an unknown keyword makes htick abandon the
    //  whole TIC, so a peer that has deliberately turned it off needs us to
    //  emit the subset only.
    //
    static get knownKeywords() {
        return new Set([
            'area',
            'areadesc',
            'origin',
            'from',
            'to',
            'file',
            'lfile',
            'fullname',
            'size',
            'date',
            'desc',
            'ldesc',
            'created',
            'magic',
            'replaces',
            'crc',
            'path',
            'seenby',
            'pw',
            //  FSC-0087 additions
            'release',
            'author',
            'source',
            'app',
            'via',
            'destination',
            'receiptrequest',
            'pgp',
        ]);
    }

    //
    //  FSC-0087: "The maximum length of a keyword line is 256 characters,
    //  including the CRLF termination."
    //
    static get maxLineLength() {
        return 254;
    }

    //
    //  |ticFileInfo|  the TIC we received, for its raw lines
    //  |options|:
    //    from                 Address -- our address for this link (required)
    //    to                   Address -- the downlink (required)
    //    password             string  -- this link's TIC password, if any
    //    crc                  string  -- computed CRC-32, any case, unpadded ok
    //    seenby               Address[] -- the complete outgoing Seenby list
    //    pathEntry            string  -- our Path line's value, sans keyword
    //    createdBy            string  -- our "Created" banner
    //    addressDimensions    '3D'|'4D'|'5D'   (default '4D')
    //    passUnknownKeywords  bool    (default true)
    //    longNames            bool    (default true)  -- emit Lfile
    //    sha256               bool    (default false) -- pass Sha256 through
    //
    static build(ticFileInfo, options = {}) {
        const opts = Object.assign(
            {
                addressDimensions: '4D',
                passUnknownKeywords: true,
                longNames: true,
                sha256: false,
            },
            options
        );

        const lines = [];
        const addrStr = addr =>
            addr instanceof Address
                ? addr.toString(opts.addressDimensions)
                : String(addr);

        //
        //  Seenby is always 4D, whatever |addressDimensions| says.
        //
        //  It is not a routing field, it is the loop guard, and it only works
        //  if the receiving processor can match it against its own link list.
        //  Synchronet's tickit does that with raw string equality --
        //  "seenbys[tic.seenby[i]] = ''" keyed by the literal text, then
        //  "seenbys[link] !== undefined" against the configured address -- so a
        //  "Seenby 21:1/200@fsxnet" simply does not match a link written as
        //  "21:1/200", and it forwards the file straight back to a node that
        //  already has it. Verified against tickit directly. Its other guard,
        //  the circular-Path check, is dead code on any well-formed TIC
        //  (it compares a whole Path line against a bare address), so ours is
        //  the only thing standing between that peer and a loop.
        //
        //  htick emits 4D-only here regardless (aka2str), and a 5D-aware
        //  processor reads 4D perfectly well since it is a subset. So 4D is
        //  universally safe and 5D buys nothing -- FTS-5006 permits either.
        //
        const seenbyStr = addr =>
            addr instanceof Address ? addr.toString('4D') : String(addr);

        //  FSC-0087 marks Created '^#': regenerated by whoever forwards.
        //  Generated lines are sanitized and length-clamped; passed-through
        //  ones are not (see clampLine).
        const emit = (keyword, value) =>
            lines.push(
                TicFileWriter.clampLine(
                    `${keyword} ${TicFileWriter.sanitizeValue(value)}`
                )
            );

        if (opts.createdBy) {
            emit('Created', opts.createdBy);
        }

        //
        //  Pass-through block, verbatim and in the order it arrived.
        //
        const regenerated = TicFileWriter.regeneratedKeywords;
        const known = TicFileWriter.knownKeywords;

        (ticFileInfo.rawLines || []).forEach(({ key, line }) => {
            if (regenerated.has(key)) {
                return;
            }

            //  Long file names. FSC-0087 marks Fullname '^', and htick emits
            //  neither Lfile nor Fullname at all -- an htick hub silently
            //  drops long names. We keep them (tickit and Mystic do), but a
            //  peer that cannot cope can turn them off.
            if ('lfile' === key || 'fullname' === key) {
                if (!opts.longNames) {
                    return;
                }
                //  FTS-5006: "It is recommended that applications always use
                //  Lfile when writing TIC files but recognise Fullname as an
                //  alias when reading."
                if ('fullname' === key) {
                    const value = TicFileWriter.lineValue(line).trim();
                    if (!value) {
                        return;
                    }
                    lines.push(`Lfile ${value}`);
                    return;
                }
            }

            //  Sha256 is in neither spec and in neither reference
            //  implementation, so to every other peer it is precisely the
            //  unknown keyword that FSC-87 subset mode rejects TICs over.
            if ('sha256' === key && !opts.sha256) {
                return;
            }

            if (!known.has(key) && !opts.passUnknownKeywords) {
                return;
            }

            //
            //  FSC-0087: "Known Keywords that are blank should not be passed
            //  though. For example, an empty AREADESC..."
            //
            //  ...but not Ldesc, which FTS-5006 defines as repeatable and
            //  explicitly multi-line: "This Keyword may occur more than once.
            //  [...] Together they form a long description." A blank Ldesc is
            //  therefore *content* -- a blank line in that description -- and
            //  the rule above is about single-valued keywords where a blank
            //  says nothing.
            //
            //  Not a hypothetical. In a corpus of 1,769 real TICs, 269 carried
            //  a blank Ldesc and 88 of those were interior: vertical spacing
            //  inside ANSI art descriptions, where dropping the line closes the
            //  gap and mangles the art. One had eight consecutive blank Ldesc
            //  lines forming the space inside a logo.
            //
            if (
                'ldesc' !== key &&
                known.has(key) &&
                !TicFileWriter.lineValue(line).trim()
            ) {
                return;
            }

            lines.push(line);
        });

        //  Computed, not announced -- see regeneratedKeywords.
        const crc = TicFileWriter.formatCrc(opts.crc);
        if (crc) {
            emit('Crc', crc);
        }

        emit('From', addrStr(opts.from));
        emit('To', addrStr(opts.to));

        //
        //  FSC-0087: "Pw [password] Site or Area password." A password is per
        //  link and is never the one we received -- that one belonged to the
        //  hop before us. String(): an unquoted password in config.hjson
        //  arrives as a number.
        //
        if (opts.password) {
            emit('Pw', opts.password);
        }

        //
        //  Path: every line we received, in order, then ours.
        //
        //  FTS-5006: "Each system should add its own line to the TIC file. Path
        //  lines should be grouped and in order of processing."
        //
        TicFileWriter.valuesOf(ticFileInfo, 'path').forEach(p => {
            lines.push(`Path ${p}`);
        });
        if (opts.pathEntry) {
            emit('Path', opts.pathEntry);
        }

        //
        //  Seenby: the complete list, one address per line. The caller builds
        //  it -- it is the loop guard and depends on the downlink set, not on
        //  this one TIC.
        //
        (opts.seenby || []).forEach(addr => {
            emit('Seenby', seenbyStr(addr));
        });

        //  FTS-5006 2.2: "Application must only write files with a CR,LF pair."
        return lines.join('\r\n') + '\r\n';
    }

    //
    //  A Path line value for |address| at |when|, per FTS-5006's
    //  "Path <addr> <unix ts> [human readable] [signature]".
    //
    //  The timestamp is decimal seconds. FSC-0087 says TimeDateStamps are
    //  hexadecimal, but FTS-5006's own example is decimal and so is every
    //  implementation in the field (htick's "%lu", tickit's Math.round) -- a
    //  hex stamp here would simply be misread.
    //
    //  Callers pass 4D deliberately rather than the link's |addressDimensions|.
    //  Both reference implementations do the same to their own Path line --
    //  htick has no 5D writer for TICs at all, and tickit strips the domain
    //  explicitly, commenting "to prevent possible problems with non-5D-aware
    //  TIC processors". Nothing parses a Path value; it is carried whole.
    //
    static pathEntry(address, when, signature, dimensions = '4D') {
        const ts = Math.floor(when.getTime() / 1000);
        const human = when.toUTCString();
        const addr =
            address instanceof Address ? address.toString(dimensions) : String(address);

        return `${addr} ${ts} ${human}${signature ? ` ${signature}` : ''}`;
    }

    //
    //  FTS-5006: "The CRC an eight digit hex number, preferably written in
    //  upper case". We store it unpadded and lower case internally
    //  (file_base_area.js: crc32.finalize().toString(16)), so both have to be
    //  fixed up on the way out -- a short CRC is a mismatch at the far end.
    //
    static formatCrc(crc) {
        if (undefined === crc || null === crc) {
            return null;
        }

        //
        //  Validate rather than pad-and-hope. The old form ran String() over
        //  whatever it was given and took the last 8 characters, so undefined
        //  became "NDEFINED", NaN became "00000NAN", and "aa\r\nPw X" came back
        //  as *two lines* -- the slice bounds characters, not lines. Emitting a
        //  wrong CRC is worse than emitting none: every htick and Mystic
        //  downlink verifies it and rejects the file with our name on the From
        //  line.
        //
        if (_.isNumber(crc) && !_.isFinite(crc)) {
            return null; //  NaN >>> 0 is 0, which would read as a valid CRC
        }

        const hex = _.isNumber(crc) ? (crc >>> 0).toString(16) : String(crc).trim();

        if (!/^[0-9a-f]{1,8}$/i.test(hex)) {
            return null;
        }

        return `00000000${hex}`.slice(-8).toUpperCase();
    }

    //
    //  The value part of a raw line: everything after the first whitespace.
    //
    //  line.search() returns -1 when a line is a bare keyword, and "+1" then
    //  slices from 0 -- so a lone "Fullname" line yielded the value "Fullname"
    //  and we emitted "Lfile Fullname", telling the downlink to store the file
    //  under that name. It also defeated the blank-value check, so a bare
    //  "Areadesc" was passed through against FSC-0087. And it was not even a
    //  fixed point: hop one emitted "Lfile ", hop two dropped it, so the TIC
    //  drifted with every hop.
    //
    static lineValue(line) {
        const idx = line.search(/\s/);
        return idx < 0 ? '' : line.slice(idx + 1);
    }

    //
    //  Strip anything that would end a line from a value we interpolate.
    //
    //  Only reachable from configuration -- a password, our Created banner, a
    //  Path entry -- since no parsed value can contain a terminator any more.
    //  But "Pw" is built from config, and a stray CR/LF in a hand-edited hjson
    //  would append whatever followed it as its own keyword line: a forged
    //  Seenby poisoning a downlink's loop guard, or a second Pw. clampLine()
    //  measures length and cannot see it.
    //
    static sanitizeValue(value) {
        // eslint-disable-next-line no-control-regex
        return String(value)
            .replace(/[\u0000-\u001f]+/g, ' ')
            .trim();
    }

    //  Values for |key| as an array, however many there were.
    static valuesOf(ticFileInfo, key) {
        const value = ticFileInfo.get(key);
        if (undefined === value) {
            return [];
        }
        return Array.isArray(value) ? value : [value];
    }

    //
    //  Keep a line within FSC-0087's limit.
    //
    //  Applied only to lines we generate -- a Path line carrying a long
    //  signature, say -- where truncating loses nothing load bearing.
    //
    //  Passed-through lines are deliberately left alone: both specs say to pass
    //  such a line "as is", and truncating one is not harmless. A long Lfile
    //  would be forwarded under a different name than the one we stored the
    //  file under, and a long Ldesc would silently lose its tail. This used to
    //  be applied to every line, contradicting the comment that said it was not.
    //
    static clampLine(line) {
        return line.length > TicFileWriter.maxLineLength
            ? line.slice(0, TicFileWriter.maxLineLength)
            : line;
    }
};

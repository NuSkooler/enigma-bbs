/* jslint node: true */
'use strict';

//  deps
const iconv = require('iconv-lite');

//
//  CP437's first 32 positions and 0x7F hold graphics on a PC -- smileys, card
//  suits, arrows, the house -- not the C0 control codes Unicode puts at those
//  code points. iconv-lite's cp437 table only describes 0x80-0xFF and fills the
//  lower half with plain ASCII, so every one of those glyphs encodes to '?' and
//  is lost on the way to a terminal that would happily have drawn it.
//
//  This registers a cp437 variant that knows about them. It is deliberately
//  asymmetric, and that asymmetry is the whole design:
//
//  *   DECODE is the stock table, byte for byte. 0x1B has to come back as ESC
//      or every ANSI sequence in every piece of art stops working.
//  *   ENCODE additionally maps the glyphs back onto their CP437 bytes.
//
//  Only code points that produce '?' today gain a mapping, so nothing that
//  already works can change. test/cp437.test.js proves that over the whole BMP.
//
//  Used for terminal output only -- see the note in client_term.js. Message
//  UUIDs, FTN packets and DOS-side files deliberately stay on stock cp437.
//
const CP437_TERM_ENCODING = 'cp437bbs';

//
//  The glyphs we are willing to put on the wire, and the byte each one is.
//
//  Left out on purpose: the bytes a terminal -- or the telnet layer under it --
//  acts on rather than draws. Emitting one of these because a string happened to
//  contain the matching glyph would ring the bell, move the cursor, or end the
//  stream early:
//
//      0x00 NUL  0x07 BEL (•)  0x08 BS (◘)  0x09 HT (○)  0x0A LF (◙)
//      0x0B VT (♂)  0x0C FF (♀)  0x0D CR (♪)  0x1A SUB (→, the SAUCE/EOF
//      marker)  0x1B ESC (←)
//
//  0x7F is the one worth watching. SyncTERM and NetRunner in BBS mode draw the
//  house, but anything applying strict NVT rules may swallow it instead. If it
//  ever misbehaves in the field, deleting its line here is the entire fix.
//
const BBS_GLYPHS = [
    [0x01, '☺'],
    [0x02, '☻'],
    [0x03, '♥'],
    [0x04, '♦'],
    [0x05, '♣'],
    [0x06, '♠'],
    [0x0e, '♫'],
    [0x0f, '☼'],
    [0x10, '►'],
    [0x11, '◄'],
    [0x12, '↕'],
    [0x13, '‼'],
    [0x14, '¶'],
    [0x15, '§'],
    [0x16, '▬'],
    [0x17, '↨'],
    [0x18, '↑'],
    [0x19, '↓'],
    [0x1c, '∟'],
    [0x1d, '↔'],
    [0x1e, '▲'],
    [0x1f, '▼'],
    [0x7f, '⌂'],
];

function registerCp437TermEncoding() {
    //  iconv.encodings is null until the first lookup fills it in, so ask for
    //  the base codec before reaching into the table.
    const base = iconv.getCodec('cp437');

    if (iconv.encodings[CP437_TERM_ENCODING]) {
        return; //  already registered
    }

    iconv.encodings[CP437_TERM_ENCODING] = function Cp437BbsCodec() {
        //  By reference: decoding is stock cp437 and must stay that way.
        this.decodeBuf = base.decodeBuf;

        //  By copy, with the glyphs written in on top of it.
        this.encodeBuf = Buffer.from(base.encodeBuf);
        BBS_GLYPHS.forEach(([byte, glyph]) => {
            this.encodeBuf[glyph.charCodeAt(0)] = byte;
        });

        //  Plain single-byte codec either way; reuse cp437's own machinery.
        this.encoder = base.encoder;
        this.decoder = base.decoder;
    };
}

registerCp437TermEncoding();

exports.CP437_TERM_ENCODING = CP437_TERM_ENCODING;
exports.BBS_GLYPHS = BBS_GLYPHS;

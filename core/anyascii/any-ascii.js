const block = require('./block.js');

const blocks = {};

/**
 * Transliterates a Unicode string into ASCII.
 *
 * @param {string} string
 * @return {string}
 */
module.exports = function anyAscii(string) {
    let result = '';
    for (const c of string) {
        const codePoint = c.codePointAt(0);
        if (codePoint <= 0x7f) {
            result += c;
            continue;
        }
        const blockNum = codePoint >>> 8;
        const lo = codePoint & 0xff;
        let b = blocks[blockNum];
        if (b === undefined) {
            blocks[blockNum] = b = block(blockNum).split('\t');
        }
        if (b.length > lo) {
            result += b[lo];
        }
    }
    return result;
};

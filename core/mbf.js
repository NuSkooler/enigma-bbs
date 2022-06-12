const { Errors } = require('./enig_error');

//
//  Utils for dealing with Microsoft Binary Format (MBF) used
//  in various BASIC languages, etc.
//
//  - https://en.wikipedia.org/wiki/Microsoft_Binary_Format
//  - https://stackoverflow.com/questions/2268191/how-to-convert-from-ieee-python-float-to-microsoft-basic-float
//

//  Number to 32bit MBF
const numToMbf32 = v => {
    const mbf = Buffer.alloc(4);

    if (0 === v) {
        return mbf;
    }

    const ieee = Buffer.alloc(4);
    ieee.writeFloatLE(v, 0);

    const sign = ieee[3] & 0x80;
    let exp = (ieee[3] << 1) | (ieee[2] >> 7);

    if (exp === 0xfe) {
        throw Errors.Invalid(`${v} cannot be converted to mbf`);
    }

    exp += 2;

    mbf[3] = exp;
    mbf[2] = sign | (ieee[2] & 0x7f);
    mbf[1] = ieee[1];
    mbf[0] = ieee[0];

    return mbf;
};

const mbf32ToNum = mbf => {
    if (0 === mbf[3]) {
        return 0.0;
    }

    const ieee = Buffer.alloc(4);
    const sign = mbf[2] & 0x80;
    const exp = mbf[3] - 2;

    ieee[3] = sign | (exp >> 1);
    ieee[2] = (exp << 7) | (mbf[2] & 0x7f);
    ieee[1] = mbf[1];
    ieee[0] = mbf[0];

    return ieee.readFloatLE(0);
};

module.exports = {
    numToMbf32,
    mbf32ToNum,
};

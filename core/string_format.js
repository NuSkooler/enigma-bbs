/* jslint node: true */
'use strict';

const EnigError = require('./enig_error.js').EnigError;

const {
    pad,
    stylizeString,
    renderStringLength,
    renderSubstr,
    formatByteSize,
    formatByteSizeAbbr,
    formatCount,
    formatCountAbbr,
} = require('./string_util.js');

//  deps
const _ = require('lodash');
const moment = require('moment');

/*
    String formatting HEAVILY inspired by David Chambers string-format library
    and the mini-language branch specifically which was gratiously released
    under the DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE.

    We need some extra functionality. Namely, support for RA style pipe codes
    and ANSI escape sequences.
*/

class ValueError extends EnigError {}
class KeyError extends EnigError {}

const SpecRegExp = {
    FillAlign: /^(.)?([<>=^])/,
    Sign: /^[ +-]/,
    Width: /^\d*/,
    Precision: /^\d+/,
};

function tokenizeFormatSpec(spec) {
    const tokens = {
        fill: '',
        align: '',
        sign: '',
        '#': false,
        0: false,
        width: '',
        ',': false,
        precision: '',
        type: '',
    };

    let index = 0;
    let match;

    function incIndexByMatch() {
        index += match[0].length;
    }

    match = SpecRegExp.FillAlign.exec(spec);
    if (match) {
        if (match[1]) {
            tokens.fill = match[1];
        }
        tokens.align = match[2];
        incIndexByMatch();
    }

    match = SpecRegExp.Sign.exec(spec.slice(index));
    if (match) {
        tokens.sign = match[0];
        incIndexByMatch();
    }

    if ('#' === spec.charAt(index)) {
        tokens['#'] = true;
        ++index;
    }

    if ('0' === spec.charAt(index)) {
        tokens['0'] = true;
        ++index;
    }

    match = SpecRegExp.Width.exec(spec.slice(index));
    tokens.width = match[0];
    incIndexByMatch();

    if (',' === spec.charAt(index)) {
        tokens[','] = true;
        ++index;
    }

    if ('.' === spec.charAt(index)) {
        ++index;

        match = SpecRegExp.Precision.exec(spec.slice(index));
        if (!match) {
            throw new ValueError('Format specifier missing precision');
        }

        tokens.precision = match[0];
        incIndexByMatch();
    }

    if (index < spec.length) {
        tokens.type = spec.charAt(index);
        ++index;
    }

    if (index < spec.length) {
        throw new ValueError('Invalid conversion specification');
    }

    if (tokens[','] && 's' === tokens.type) {
        throw new ValueError(`Cannot specify ',' with 's'`); //  eslint-disable-line quotes
    }

    return tokens;
}

function quote(s) {
    return `"${s.replace(/"/g, '\\"')}"`;
}

function getPadAlign(align) {
    return (
        {
            '<': 'left',
            '>': 'right',
            '^': 'center',
        }[align] || '>'
    );
}

function formatString(value, tokens) {
    const fill = tokens.fill || (tokens['0'] ? '0' : ' ');
    const align = tokens.align || (tokens['0'] ? '=' : '<');
    const precision = Number(tokens.precision || renderStringLength(value) + 1);

    if ('' !== tokens.type && 's' !== tokens.type) {
        throw new ValueError(`Unknown format code "${tokens.type}" for String object`);
    }

    if (tokens[',']) {
        throw new ValueError(`Cannot specify ',' with 's'`); //  eslint-disable-line quotes
    }

    if (tokens.sign) {
        throw new ValueError('Sign not allowed in string format specifier');
    }

    if (tokens['#']) {
        throw new ValueError('Alternate form (#) not allowed in string format specifier');
    }

    if ('=' === align) {
        throw new ValueError('"=" alignment not allowed in string format specifier');
    }

    return pad(
        renderSubstr(value, 0, precision),
        Number(tokens.width),
        fill,
        getPadAlign(align)
    );
}

const FormatNumRegExp = {
    UpperType: /[A-Z]/,
    ExponentRep: /e[+-](?=\d$)/,
};

function formatNumberHelper(n, precision, type) {
    if (FormatNumRegExp.UpperType.test(type)) {
        return formatNumberHelper(n, precision, type.toLowerCase()).toUpperCase();
    }

    switch (type) {
        case 'c':
            return String.fromCharCode(n);
        case 'd':
            return n.toString(10);
        case 'b':
            return n.toString(2);
        case 'o':
            return n.toString(8);
        case 'x':
            return n.toString(16);
        case 'e':
            return n.toExponential(precision).replace(FormatNumRegExp.ExponentRep, '$&0');
        case 'f':
            return n.toFixed(precision);
        case 'g':
            //  we don't want useless trailing zeros. parseFloat -> back to string fixes this for us
            return parseFloat(n.toPrecision(precision || 1)).toString();

        case '%':
            return formatNumberHelper(n * 100, precision, 'f') + '%';
        case '':
            return formatNumberHelper(n, precision, 'd');

        default:
            throw new ValueError(
                `Unknown format code "${type}" for object of type 'float'`
            );
    }
}

function formatNumber(value, tokens) {
    const fill = tokens.fill || (tokens['0'] ? '0' : ' ');
    const align = tokens.align || (tokens['0'] ? '=' : '>');
    const width = Number(tokens.width);
    const type = tokens.type || (tokens.precision ? 'g' : '');

    if (['c', 'd', 'b', 'o', 'x', 'X'].indexOf(type) > -1) {
        if (0 !== value % 1) {
            throw new ValueError(
                `Cannot format non-integer with format specifier "${type}"`
            );
        }

        if ('' !== tokens.sign && 'c' !== type) {
            throw new ValueError(`Sign not allowed with integer format specifier 'c'`); //  eslint-disable-line quotes
        }

        if (tokens[','] && 'd' !== type) {
            throw new ValueError(`Cannot specify ',' with '${type}'`);
        }

        if ('' !== tokens.precision) {
            throw new ValueError('Precision not allowed in integer format specifier');
        }
    } else if (['e', 'E', 'f', 'F', 'g', 'G', '%'].indexOf(type) > -1) {
        if (tokens['#']) {
            throw new ValueError(
                'Alternate form (#) not allowed in float format specifier'
            );
        }
    }

    const s = formatNumberHelper(Math.abs(value), Number(tokens.precision || 6), type);
    const sign =
        value < 0 || 1 / value < 0 ? '-' : '-' === tokens.sign ? '' : tokens.sign;

    const prefix =
        tokens['#'] && ['b', 'o', 'x', 'X'].indexOf(type) > -1 ? '0' + type : '';

    if (tokens[',']) {
        const match = /^(\d*)(.*)$/.exec(s);
        const separated = match[1].replace(/.(?=(...)+$)/g, '$&,') + match[2];

        if ('=' !== align) {
            return pad(sign + separated, width, fill, getPadAlign(align));
        }

        if ('0' === fill) {
            const shortfall = Math.max(0, width - sign.length - separated.length);
            const digits = /^\d*/.exec(separated)[0].length;
            let padding = '';
            //  :TODO: do this differntly...
            for (let n = 0; n < shortfall; n++) {
                padding = ((digits + n) % 4 === 3 ? ',' : '0') + padding;
            }

            return sign + (/^,/.test(padding) ? '0' : '') + padding + separated;
        }

        return sign + pad(separated, width - sign.length, fill, getPadAlign('>'));
    }

    if (0 === width) {
        return sign + prefix + s;
    }

    if ('=' === align) {
        return (
            sign +
            prefix +
            pad(s, width - sign.length - prefix.length, fill, getPadAlign('>'))
        );
    }

    return pad(sign + prefix + s, width, fill, getPadAlign(align));
}

const transformers = {
    //  String standard
    toUpperCase: String.prototype.toUpperCase,
    toLowerCase: String.prototype.toLowerCase,

    //  some super l33b BBS styles!!
    styleUpper: s => stylizeString(s, 'upper'),
    styleLower: s => stylizeString(s, 'lower'),
    styleTitle: s => stylizeString(s, 'title'),
    styleFirstLower: s => stylizeString(s, 'first lower'),
    styleSmallVowels: s => stylizeString(s, 'small vowels'),
    styleBigVowels: s => stylizeString(s, 'big vowels'),
    styleSmallI: s => stylizeString(s, 'small i'),
    styleMixed: s => stylizeString(s, 'mixed'),
    styleL33t: s => stylizeString(s, 'l33t'),

    //  :TODO:
    //  toMegs(), toKilobytes(), ...
    //  toList(), toCommaList(),

    sizeWithAbbr: n => formatByteSize(n, true, 2),
    sizeWithoutAbbr: n => formatByteSize(n, false, 2),
    sizeAbbr: n => formatByteSizeAbbr(n),
    countWithAbbr: n => formatCount(n, true, 0),
    countWithoutAbbr: n => formatCount(n, false, 0),
    countAbbr: n => formatCountAbbr(n),

    durationHours: h => moment.duration(h, 'hours').humanize(),
    durationMinutes: m => moment.duration(m, 'minutes').humanize(),
    durationSeconds: s => moment.duration(s, 'seconds').humanize(),
};

function transformValue(transformerName, value) {
    if (transformerName in transformers) {
        const transformer = transformers[transformerName];
        value = transformer.apply(value, [value]);
    }

    return value;
}

//  :TODO: Use explicit set of chars for paths & function/transforms such that } is allowed as fill/etc.
const REGEXP_BASIC_FORMAT = /{([^.!:}]+(?:\.[^.!:}]+)*)(?:!([^:}]+))?(?::([^}]+))?}/g;

function getValue(obj, path) {
    const value = _.get(obj, path);
    if (!_.isUndefined(value)) {
        return _.isFunction(value) ? value() : value;
    }

    throw new KeyError(quote(path));
}

module.exports = function format(fmt, obj) {
    const re = REGEXP_BASIC_FORMAT;
    re.lastIndex = 0; //  reset from prev

    let match;
    let pos;
    let out = '';
    let objPath;
    let transformer;
    let formatSpec;
    let value;
    let tokens;

    do {
        pos = re.lastIndex;
        match = re.exec(fmt);

        if (match) {
            if (match.index > pos) {
                out += fmt.slice(pos, match.index);
            }

            objPath = match[1];
            transformer = match[2];
            formatSpec = match[3];

            try {
                value = getValue(obj, objPath);
                if (transformer) {
                    value = transformValue(transformer, value);
                }

                tokens = tokenizeFormatSpec(formatSpec || '');

                if (_.isNumber(value)) {
                    out += formatNumber(value, tokens);
                } else {
                    out += formatString(value, tokens);
                }
            } catch (e) {
                if (e instanceof KeyError) {
                    out += match[0]; //  preserve full thing
                } else if (e instanceof ValueError) {
                    out += value.toString();
                }
            }
        }
    } while (0 !== re.lastIndex);

    //  remainder
    if (pos < fmt.length) {
        out += fmt.slice(pos);
    }

    return out;
};

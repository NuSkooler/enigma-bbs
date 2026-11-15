'use strict';

//
//  The smallest terminal that can tell two byte streams apart by what they
//  leave on screen: cursor moves (CSI row;col H / f), SGR attributes, erase
//  in line and display, CR/LF, and printable characters. Each cell keeps its
//  character and the attributes it was written with. Anything else in CSI
//  form (cursor show/hide, ...) is consumed and ignored.
//

const DEFAULT_ATTRS = Object.freeze({
    bold: false,
    dim: false,
    blink: false,
    reverse: false,
    fg: 39,
    bg: 49,
});

class VirtualScreen {
    constructor(cols = 80, rows = 25) {
        this.cols = cols;
        this.rows = rows;
        this.row = 1;
        this.col = 1;
        this.attrs = Object.assign({}, DEFAULT_ATTRS);
        this.cells = [];
        for (let r = 0; r < rows; ++r) {
            this.cells.push(this._blankRow());
        }
    }

    _blankRow() {
        const row = [];
        for (let c = 0; c < this.cols; ++c) {
            row.push(' ' + this._attrKey(DEFAULT_ATTRS));
        }
        return row;
    }

    _attrKey(a) {
        return `|${a.bold ? 1 : 0}${a.dim ? 1 : 0}${a.blink ? 1 : 0}${a.reverse ? 1 : 0}:${
            a.fg
        }:${a.bg}`;
    }

    _sgr(params) {
        const list = params.length ? params.split(';') : ['0'];
        list.forEach(p => {
            const n = '' === p ? 0 : parseInt(p, 10);
            if (0 === n) {
                this.attrs = Object.assign({}, DEFAULT_ATTRS);
            } else if (1 === n) {
                this.attrs.bold = true;
            } else if (2 === n) {
                this.attrs.dim = true;
            } else if (22 === n) {
                this.attrs.bold = false;
                this.attrs.dim = false;
            } else if (5 === n) {
                this.attrs.blink = true;
            } else if (25 === n) {
                this.attrs.blink = false;
            } else if (7 === n) {
                this.attrs.reverse = true;
            } else if (27 === n) {
                this.attrs.reverse = false;
            } else if ((n >= 30 && n <= 37) || 39 === n) {
                this.attrs.fg = n;
            } else if ((n >= 40 && n <= 47) || 49 === n) {
                this.attrs.bg = n;
            }
        });
    }

    _put(ch) {
        if (
            this.row >= 1 &&
            this.row <= this.rows &&
            this.col >= 1 &&
            this.col <= this.cols
        ) {
            this.cells[this.row - 1][this.col - 1] = ch + this._attrKey(this.attrs);
        }
        ++this.col;
    }

    write(data) {
        const s = String(data);
        let i = 0;
        while (i < s.length) {
            const ch = s[i];
            if ('\x1b' === ch && '[' === s[i + 1]) {
                let j = i + 2;
                while (j < s.length && /[0-9;?]/.test(s[j])) {
                    ++j;
                }
                const params = s.slice(i + 2, j);
                const final = s[j];
                if ('H' === final || 'f' === final) {
                    const [r, c] = params.split(';');
                    this.row = parseInt(r, 10) || 1;
                    this.col = parseInt(c, 10) || 1;
                } else if ('m' === final) {
                    this._sgr(params);
                } else if ('K' === final) {
                    for (let c = this.col; c <= this.cols; ++c) {
                        this.cells[this.row - 1][c - 1] = ' ' + this._attrKey(this.attrs);
                    }
                } else if ('J' === final && '2' === params) {
                    for (let r = 0; r < this.rows; ++r) {
                        this.cells[r] = this._blankRow();
                    }
                }
                i = j + 1;
                continue;
            }
            if ('\r' === ch) {
                this.col = 1;
            } else if ('\n' === ch) {
                ++this.row;
            } else {
                this._put(ch);
            }
            ++i;
        }
        return this;
    }

    //  Characters only, one string per row
    text() {
        return this.cells.map(row => row.map(cell => cell[0]).join(''));
    }

    //  Characters and attributes: equal snapshots look the same
    snapshot() {
        return this.cells.map(row => row.join('')).join('\n');
    }

    cursor() {
        return { row: this.row, col: this.col };
    }
}

module.exports = { VirtualScreen };

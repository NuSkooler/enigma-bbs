'use strict';

//
//  Where an mciMap's art was drawn: the screen cell of the art's top-left
//  corner, { row, col } (1-based). A view placed by config `position` (no
//  marker in the art) counts its position from there, as a marker would be
//  counted from wherever the art was drawn.
//
//  Kept under a symbol, so the map's own keys (one per MCI code) are all
//  that Object.keys(), lodash and a mod iterating it ever see. A map made
//  some other way (a mod's own, or {}) has its art at row 1, column 1.
//
const ArtOrigin = Symbol('mciMapArtOrigin');

const DefaultOrigin = Object.freeze({ row: 1, col: 1 });

function getArtOrigin(mciMap) {
    const origin = mciMap && mciMap[ArtOrigin];
    return origin ? { row: origin.row, col: origin.col } : { ...DefaultOrigin };
}

function setArtOrigin(mciMap, origin) {
    if (!mciMap || 'object' !== typeof mciMap) {
        return;
    }
    Object.defineProperty(mciMap, ArtOrigin, {
        value: { row: origin.row, col: origin.col },
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

//  move |mciMap|'s origin by |rows| and |cols| (art that scrolled, a prompt
//  drawn elsewhere)
function shiftArtOrigin(mciMap, rows, cols) {
    const origin = getArtOrigin(mciMap);
    setArtOrigin(mciMap, { row: origin.row + rows, col: origin.col + cols });
}

module.exports = { getArtOrigin, setArtOrigin, shiftArtOrigin };

/* jslint node: true */
'use strict';

//  deps
const _ = require('lodash');

exports.sortAreasOrConfs = sortAreasOrConfs;

//
//  Method for sorting message, file, etc. areas and confs
//  If the sort key is present and is a number, sort in numerical order;
//  Otherwise, use a locale comparison on the sort key or name as a fallback
//
function sortAreasOrConfs(areasOrConfs, type) {
    let entryA;
    let entryB;

    areasOrConfs.sort((a, b) => {
        entryA = type ? a[type] : a;
        entryB = type ? b[type] : b;

        if (_.isNumber(entryA.sort) && _.isNumber(entryB.sort)) {
            return entryA.sort - entryB.sort;
        } else {
            const keyA = entryA.sort ? entryA.sort.toString() : entryA.name;
            const keyB = entryB.sort ? entryB.sort.toString() : entryB.name;
            return keyA.localeCompare(keyB, { sensitivity: false, numeric: true }); //  "natural" compare
        }
    });
}

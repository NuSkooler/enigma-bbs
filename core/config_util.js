/* jslint node: true */
'use strict';

const Config = require('./config.js').get;

//  deps
const paths = require('path');

exports.getConfigPath = getConfigPath;

function getConfigPath(filePath) {
    //  |filePath| is assumed to be in the config path if it's only a file name
    if('.' === paths.dirname(filePath)) {
        filePath = paths.join(Config().paths.config, filePath);
    }
    return filePath;
}

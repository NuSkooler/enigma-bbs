/* jslint node: true */
'use strict';

const Config = require('./config.js').get;

//  deps
const paths = require('path');

exports.getConfigPath = getConfigPath;

function getConfigPath(filePath) {
    if (paths.isAbsolute(filePath)) {
        return filePath;
    }

    return paths.join(Config().paths.config, filePath);
}

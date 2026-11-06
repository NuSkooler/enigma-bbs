/* jslint node: true */
'use strict';

//  deps
const paths = require('path');

exports.getConfigPath = getConfigPath;

function getConfigPath(filePath) {
    if (paths.isAbsolute(filePath)) {
        return filePath;
    }

    //
    //  Looked up on every call rather than captured when this module loads:
    //  config.js only defines get() once Config.create() has run, and
    //  --config is processed after much of the code that requires this.
    //
    const Config = require('./config.js').get;
    return paths.join(Config().paths.config, filePath);
}

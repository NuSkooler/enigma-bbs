/* jslint node: true */
'use strict';

var FullScreenEditorModule = require('./fse.js').FullScreenEditorModule;

exports.getModule = AreaReplyFSEModule;

exports.moduleInfo = {
    name: 'Message Area Reply',
    desc: 'Module for replying to an area message',
    author: 'NuSkooler',
};

function AreaReplyFSEModule(options) {
    FullScreenEditorModule.call(this, options);
}

require('util').inherits(AreaReplyFSEModule, FullScreenEditorModule);

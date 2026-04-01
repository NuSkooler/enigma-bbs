/* jslint node: true */
'use strict';

const { FullScreenEditorModule } = require('./fse.js');

exports.moduleInfo = {
    name: 'Message Area Reply',
    desc: 'Module for replying to an area message',
    author: 'NuSkooler',
};

//  All reply logic lives in the base class; this module is a thin named entry point.
exports.getModule = class AreaReplyFSEModule extends FullScreenEditorModule {};

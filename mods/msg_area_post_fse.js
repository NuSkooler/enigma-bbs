/* jslint node: true */
'use strict';

var FullScreenEditorModule		= require('../core/fse.js').FullScreenEditorModule;

exports.getModule				= AreaPostFSEModule;

exports.moduleInfo = {
	name	: 'Message Area Post',
	desc	: 'Module posting a new message to an area',
	author	: 'NuSkooler',
};

function AreaPostFSEModule(options) {
	FullScreenEditorModule.call(this, options);

	//	we're posting, so always start with 'edit' mode
	this.editorMode = 'edit';

}

require('util').inherits(AreaPostFSEModule, FullScreenEditorModule);


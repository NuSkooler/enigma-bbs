/* jslint node: true */
'use strict';

exports.parseAsset			= parseAsset;

var ALL_ASSETS = [
	'art',
	'menu',
	'method',
	'prompt',
];

//	\@(art|menu|method)\:([\w\.]*)(?:\/?([\w\d\_]+))*
var ASSET_RE = new RegExp('\\@(' + ALL_ASSETS.join('|') + ')\\:([\\w\\.]*)(?:\\?/([\\w\\d\\_]+))*');

function parseAsset(s) {	
	var m = ASSET_RE.exec(s);

	if(m) {
		var result = { type : m[1] };

		if(m[3]) {
			result.location = m[2];
			result.asset	= m[3];
		} else {
			result.asset	= m[2];
		}

		return result;
	}
}
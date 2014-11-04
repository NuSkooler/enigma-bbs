/* jslint node: true */
'use strict';

var ansi			= require('../core/ansi_term.js');
var theme			= require('../core/theme.js');
var viewController	= require('../core/view_controller.js');
var art				= require('../core/art.js');
var async			= require('async');

exports.moduleInfo = {
	name	: 'Test Module 2',
	desc	: 'A Test Module',
	author	: 'NuSkooler',
};

exports.entryPoint = entryPoint;

function entryPoint(client) {
	var term = client.term;

	term.write(ansi.resetScreen());

	async.waterfall(
		[
			function getArt(callback) {
				theme.getThemeArt('MCI_VM1.ANS', client.user.properties.art_theme_id, function onArt(err, theArt) {
					callback(err, theArt);
				});
			},
			function displayArt(theArt, callback) {
				art.display(theArt, { client : client, mciReplaceChar : ' ' }, function onDisplayed(err, mci) {
					callback(err, mci);
				});
			},
			function artDisplayed(mci, callback) {
				var vc = new viewController.ViewController(client);
				vc.loadFromMCIMap(mci);
				vc.getView(1).setItems(['Item 1', 'Item Two', 'The Third']);
				vc.setViewOrder();
				vc.switchFocus(1);
			}
		],
		function onComplete(err) {
			console.log(err);
		}
	);
}
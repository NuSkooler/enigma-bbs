/* jslint node: true */
'use strict';

/*

--- Instructions:
To install this module, you will need to run npm install inside the
mods/rss_view directory.

To configure this module, it is intended that you might create a NEWS menu, then
from that menu each RSS feed would have an option.

You would then create a Menu Block for each RSS feed you want to display.

Next, to fetch the articles, you add a list of rss feeds to config.hjson and
an event block that will fetch all of the listed rss feeds.

--- Example RSS fetcher configuration (Goes in  ~/.config/enigma-bbs/config.hjson):

rssFeeds: [
	https://github.com/NuSkooler/enigma-bbs/commits/master.atom
]


--- Example Event Block (Goes in ~/.config/enigma-bbs/config.hjson):

eventScheduler : {
				events: {
								fetchRSSFeeds: {
												schedule: every 30 minutes
												action: @method:mods/rss_view/rss_view.js:fetchRSSFeedsEvent
								}
				}
}


--- Example Menu Block (Goes in menu.hjson, Need one for each RSS feed):

mainMenuRSSFeed: {
	desc: Viewing an RSS feed
	module: rss_view
	art: RSSVIEW.ANS
	config: {
		rssUrl: https://github.com/NuSkooler/enigma-bbs/commits/master.atom
	}
	form: {
		0: {
			mci: {
				VM2: {
					height: 8
					width: 79
				}
				MT3: {
					mode: preview
					autoScroll: false
					height: 12
					width: 79
				}
			}
			actionKeys: [
				{
					keys: [ "tab" ]
					action: @method:tabPressed
				},
				{
					keys: [ "escape", "q", "shift + q" ]
					action: @systemMethod:prevMenu
				}
			]
		}
	}
}

*/


const MenuModule		= require('../../core/menu_module.js').MenuModule;

//	deps
const async			= require('async');
const sqlite3			= require('sqlite3').verbose();
const getModDatabasePath			= require('../../core/database.js').getModDatabasePath;
const Config		= require('../../core/config.js').config;
const feedRead = require('feed-read');
const moment				= require('moment');
var htmlToText = require('html-to-text');

const moduleInfo = {
	name	: 'RSS Viewer',
	desc	: 'Fetch and View an RSS feed',
	author	: 'Andrew Pamment',
	packageName: 'com.magickabbs.enigma.rssviewer'
};

const MciViewIds = {
	RSSTitle : 1,
	ArticleTitles : 2,
	ArticleView 	: 3,
};

exports.moduleInfo = moduleInfo;
exports.getModule	= RSSViewModule;
exports.fetchRSSFeedsEvent = fetchRSSFeedsEvent;

function RSSViewModule(options) {
	MenuModule.call(this, options);

	const self			= this;
	this.config			= options.menuConfig.config;
	this.whoHasFocus = MciViewIds.ArticleTitles;

	this.menuMethods = {
		tabPressed : function() {
			if (self.whoHasFocus === MciViewIds.ArticleTitles) {
				self.viewControllers.menu.switchFocus(MciViewIds.ArticleView);
				self.whoHasFocus = MciViewIds.ArticleView;
			} else {
				self.viewControllers.menu.switchFocus(MciViewIds.ArticleTitles);
				self.whoHasFocus = MciViewIds.ArticleTitles;
			}
		}
	};

	this.finishedLoading = function() {
		async.series(
			[
				function initDatabase(callback) {
					async.series(
						[
							function openDatabase(callback) {
								self.database = new sqlite3.Database(
									getModDatabasePath(exports.moduleInfo),
									callback
								);
							},
							function createTables(callback) {
								self.database.serialize( () => {
									self.database.run(
										'CREATE TABLE IF NOT EXISTS articles(' +
										'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
										'rss_url TEXT,' +
										'article_title TEXT,' +
										'article_description TEXT,' +
										'article_date TIMESTAMP,' +
										'article_link TEXT);'
									);
									self.database.run(
										'CREATE TABLE IF NOT EXISTS feeds(' +
										'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
										'rss_url TEXT,' +
										'feed_title TEXT,' +
										'feed_source TEXT,' +
										'feed_link TEXT);'
									);
								});
								callback(null);
							}
						], callback
					);
				},
				function loadRSSTitle(callback) {
					self.database.serialize( () => {
						self.database.get(
							'SELECT feed_title ' +
							'FROM feeds WHERE rss_url LIKE ? ',
							[ self.config.rssUrl ],
							(err, row) => {
								if (!err && row) {
									self.viewControllers.menu.getView(MciViewIds.RSSTitle).setText(row.feed_title);
									callback(null);
								}
							}
						);
					});
				},
				function loadRSSFeed(callback) {
					self.entries = [];
					self.database.serialize( () => {
						self.database.all(
							'SELECT article_title, article_description, article_date, article_link, article_author ' +
							'FROM articles WHERE rss_url LIKE ? ' +
							'ORDER BY article_date DESC LIMIT 30',
							[ self.config.rssUrl ],
							(err, rows) => {
								if (!err) {
									for (var i = 0; i < rows.length; i++) {
										self.entries.push(rows[i]);
									}
									callback(null);
								}
							}
						);
					});
				},
				function displayArticleList(callback) {
					const titleView = self.viewControllers.menu.getView(MciViewIds.ArticleTitles);
					const listFormat = self.config.listFormat || '|00|10{title:<79.78}';
					const focusFormat = self.config.focusFormat || '|00|15|18{title:<79.78}';
					titleView.setItems(self.entries.map( e => {
						return listFormat.format({
							title : e.article_title
						});
					}));
					titleView.setFocusItems(self.entries.map( e => {
						return focusFormat.format({
							title : e.article_title
						});
					}));

					titleView.on('index update', function indexUpdated(idx) {
						if (self.entries.length === 0 || idx > self.entries.length) {
							self.viewControllers.menu.getView(MciViewIds.ArticleView).setText('');
						} else {
							self.viewControllers.menu.getView(MciViewIds.ArticleView).setText(
								' > BY ' + self.entries[idx].article_author + '\r\n' +
								' > ' + self.entries[idx].article_link + '\r\n' +
								' > ' + self.entries[idx].article_date + '\r\n\r\n' +
								self.entries[idx].article_description
							);
						}
						self.viewControllers.menu.getView(MciViewIds.ArticleView).redraw();
					});

					if (self.entries.length > 0) {
						self.viewControllers.menu.getView(MciViewIds.ArticleView).setText(
							' > BY ' + self.entries[0].article_author + '\r\n' +
							' > ' + self.entries[0].article_link + '\r\n' +
							' > ' + self.entries[0].article_date + '\r\n\r\n' +
							self.entries[0].article_description
						);
					}

					titleView.redraw();
					self.viewControllers.menu.switchFocus(MciViewIds.ArticleTitles);
					callback(null);
				}
			]
		);
	};
}

require('util').inherits(RSSViewModule, MenuModule);

RSSViewModule.prototype.mciReady = function(mciData, cb) {
	this.standardMCIReadyHandler(mciData, cb);
};

function fetchRSSFeedsEvent(args, cb) {
	let feeds = Config.rssFeeds;
	let database;

	function initDatabase() {
		async.series(
			[
				function openDatabase(callback) {
					database = new sqlite3.Database(
						getModDatabasePath(exports.moduleInfo),
						callback
					);
				},
				function createTables(callback) {
					database.serialize( () => {
						database.run(
							'CREATE TABLE IF NOT EXISTS articles(' +
							'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
							'rss_url TEXT,' +
							'article_title TEXT,' +
							'article_author TEXT,' +
							'article_description TEXT,' +
							'article_date TIMESTAMP,' +
							'article_link TEXT);'
						);
						database.run(
							'CREATE TABLE IF NOT EXISTS feeds(' +
							'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
							'rss_url TEXT,' +
							'feed_title TEXT,' +
							'feed_source TEXT,' +
							'feed_link TEXT);'
						);
					});
					callback(null);
				}
			]
		);
	}

	initDatabase();

	feeds.forEach( feed => {
		async.waterfall(
			[
				function readArticles(callback) {
					feedRead(feed, function(err, articles) {
						if (!err) {
							if (articles.length > 0) {
								callback(null, articles);
							} else {
								callback('done', articles);
							}
						} else {
							callback(err);
						}
					});
				},
				function loadFeedDetails(articles, callback) {
					database.serialize( () => {
						database.get(
							'SELECT rss_url FROM feeds WHERE rss_url LIKE ?',
							[ feed ],
							function(err, row) {
								if (row) {
									callback(null, false, articles);
								} else {
									callback(null, true, articles);
								}
							}
						);
					});
				},
				function saveFeedDetails(doSave, articles, callback) {
					if (doSave) {
						database.serialize( () => {
							database.run(
								'INSERT INTO feeds (rss_url, feed_title, feed_source, feed_link) VALUES(?, ?, ?, ?)',
								[feed, articles[0].feed.name, articles[0].feed.source, articles[0].feed.link],
								function(err) {
									callback(err, articles);
								}
							);
						});
					} else {
						callback(null, articles);
					}
				},
				function saveArticles(articles, callback) {
					articles.forEach( article => {
						async.waterfall(
							[
								function checkIfArticleExists(callback){
									database.serialize(() => {
										database.get(
											'SELECT id FROM articles WHERE article_link LIKE ?',
											[ article.link ],
											function(err, row) {
												if (row) {
													callback(err, true);
												} else {
													callback(err, false);
												}
											}
										);
									});
								},
								function saveArticle(done, callback) {
									if (!done) {
										let date = moment(article.published);
										let ts = date.format('YYYY-MM-DDTHH:mm:ss.SSSZ');
										database.serialize(() => {
											database.run(
												'INSERT INTO articles (rss_url, article_title, article_link, article_author, article_description, article_date) VALUES(?, ?, ?, ?, ?, ?)',
												[feed, article.title, article.link, article.author, htmlToText.fromString(article.content, {word_wrap: 75}), ts]
											);
										});
									}
									callback(null);
								}
							]
						);
					});
					callback(null);
				}
			]
		);
	});

	cb(null);
}

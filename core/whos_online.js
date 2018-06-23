/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule            = require('./menu_module.js').MenuModule;
const ViewController        = require('./view_controller.js').ViewController;
const getActiveNodeList     = require('./client_connections.js').getActiveNodeList;
const stringFormat          = require('./string_format.js');

//  deps
const async                 = require('async');
const _                     = require('lodash');

exports.moduleInfo = {
    name        : 'Who\'s Online',
    desc        : 'Who is currently online',
    author      : 'NuSkooler',
    packageName : 'codes.l33t.enigma.whosonline'
};

const MciViewIds = {
    OnlineList      : 1,
};

exports.getModule = class WhosOnlineModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            const self  = this;
            const vc    = self.viewControllers.allViews = new ViewController( { client : self.client } );

            async.series(
                [
                    function loadFromConfig(callback) {
                        const loadOpts = {
                            callingMenu     : self,
                            mciMap          : mciData.menu,
                            noInput         : true,
                        };

                        return vc.loadFromMenuConfig(loadOpts, callback);
                    },
                    function populateList(callback) {
                        const onlineListView    = vc.getView(MciViewIds.OnlineList);
                        const listFormat        = self.menuConfig.config.listFormat || '{node} - {userName} - {action} - {timeOn}';
                        const nonAuthUser       = self.menuConfig.config.nonAuthUser || 'Logging In';
                        const otherUnknown      = self.menuConfig.config.otherUnknown || 'N/A';
                        const onlineList        = getActiveNodeList(self.menuConfig.config.authUsersOnly).slice(0, onlineListView.height);

                        onlineListView.setItems(_.map(onlineList, oe => {
                            if(oe.authenticated) {
                                oe.timeOn = _.upperFirst(oe.timeOn.humanize());
                            } else {
                                [ 'realName', 'location', 'affils', 'timeOn' ].forEach(m => {
                                    oe[m] = otherUnknown;
                                });
                                oe.userName = nonAuthUser;
                            }
                            return stringFormat(listFormat, oe);
                        }));

                        onlineListView.focusItems = onlineListView.items;
                        onlineListView.redraw();

                        return callback(null);
                    }
                ],
                function complete(err) {
                    if(err) {
                        self.client.log.error( { error : err.message }, 'Error loading who\'s online');
                    }
                    return cb(err);
                }
            );
        });
    }
};

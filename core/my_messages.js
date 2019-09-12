/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule    = require('./menu_module.js').MenuModule;
const Message       = require('./message.js');
const UserProps     = require('./user_property.js');
const {
    hasMessageConfAndAreaRead
}                   = require('./message_area.js');

exports.moduleInfo = {
    name    : 'My Messages',
    desc    : 'Finds messages addressed to the current user.',
    author  : 'NuSkooler',
};

exports.getModule = class MyMessagesModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    initSequence() {
        const filter = {
            toUserName  : [ this.client.user.username, this.client.user.getProperty(UserProps.RealName) ],
            sort        : 'modTimestamp',
            resultType  : 'messageList',
            limit       : 1024 * 16,    //  we want some sort of limit...
        };

        Message.findMessages(filter, (err, messageList) => {
            if(err) {
                this.client.log.warn( { error : err.message }, 'Error finding messages addressed to current user');
                return this.prevMenu();
            }

            //
            //  We need to filter out messages belonging to conf/areas the user
            //  doesn't have access to.
            //
            //  Keep a cache around for quick lookup.
            //
            const acsCache = new Map();    //  areaTag:boolean
            this.messageList = messageList.filter(msg => {
                let cached = acsCache.get(msg.areaTag);
                if(false === cached) {
                    return false;
                }
                if(true === cached) {
                    return true;
                }
                cached = hasMessageConfAndAreaRead(this.client, msg.areaTag);
                acsCache.set(msg.areaTag, cached);
                return cached;
            });

            this.finishedLoading();
        });
    }

    finishedLoading() {
        if(!this.messageList || 0 === this.messageList.length) {
            return this.gotoMenu(
                this.menuConfig.config.noResultsMenu || 'messageSearchNoResults',
                { menuFlags : [ 'popParent' ] }
            );
        }

        const menuOpts = {
            extraArgs : {
                messageList         : this.messageList,
                noUpdateLastReadId  : true
            },
            menuFlags   : [ 'popParent' ],
        };

        return this.gotoMenu(
            this.menuConfig.config.messageListMenu || 'messageAreaMessageList',
            menuOpts
        );
    }
};

/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuModule = require('./menu_module.js').MenuModule;
const Message = require('./message.js');
const UserProps = require('./user_property.js');
const { filterMessageListByReadACS } = require('./message_area.js');

exports.moduleInfo = {
    name: 'My Messages',
    desc: 'Finds messages addressed to the current user.',
    author: 'NuSkooler',
};

exports.getModule = class MyMessagesModule extends MenuModule {
    constructor(options) {
        super(options);
    }

    initSequence() {
        const filter = {
            toUserName: [
                this.client.user.username,
                this.client.user.getProperty(UserProps.RealName),
            ],
            sort: 'modTimestamp',
            resultType: 'messageList',
            limit: 1024 * 16, //  we want some sort of limit...
        };

        Message.findMessages(filter, (err, messageList) => {
            if (err) {
                this.client.log.warn(
                    { error: err.message },
                    'Error finding messages addressed to current user'
                );
                return this.prevMenu();
            }

            //  don't include results without ACS
            this.messageList = filterMessageListByReadACS(this.client, messageList);

            this.finishedLoading();
        });
    }

    finishedLoading() {
        if (!this.messageList || 0 === this.messageList.length) {
            return this.gotoMenu(
                this.menuConfig.config.noResultsMenu || 'messageSearchNoResults',
                { menuFlags: ['popParent'] }
            );
        }

        const menuOpts = {
            extraArgs: {
                messageList: this.messageList,
                noUpdateLastReadId: true,
            },
            menuFlags: ['popParent'],
        };

        return this.gotoMenu(
            this.menuConfig.config.messageListMenu || 'messageAreaMessageList',
            menuOpts
        );
    }
};

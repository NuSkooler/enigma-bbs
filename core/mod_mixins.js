/* jslint node: true */
'use strict';

const messageArea = require('../core/message_area.js');
const UserProps = require('./user_property.js');

//  deps
const { get } = require('lodash');

exports.MessageAreaConfTempSwitcher = Sup =>
    class extends Sup {
        tempMessageConfAndAreaSwitch(messageAreaTag, recordPrevious = true) {
            messageAreaTag =
                messageAreaTag || get(this, 'config.messageAreaTag', this.messageAreaTag);
            if (!messageAreaTag) {
                return; //  nothing to do!
            }

            if (recordPrevious) {
                this.prevMessageConfAndArea = {
                    confTag: this.client.user.properties[UserProps.MessageConfTag],
                    areaTag: this.client.user.properties[UserProps.MessageAreaTag],
                };
            }

            if (!messageArea.tempChangeMessageConfAndArea(this.client, messageAreaTag)) {
                this.client.log.warn(
                    { messageAreaTag: messageArea },
                    'Failed to perform temporary message area/conf switch'
                );
            }
        }

        tempMessageConfAndAreaRestore() {
            if (this.prevMessageConfAndArea) {
                this.client.user.properties[UserProps.MessageConfTag] =
                    this.prevMessageConfAndArea.confTag;
                this.client.user.properties[UserProps.MessageAreaTag] =
                    this.prevMessageConfAndArea.areaTag;
            }
        }
    };

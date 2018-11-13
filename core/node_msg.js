/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule }        = require('./menu_module.js');
const { Errors }            = require('./enig_error.js');
const {
    getActiveNodeList,
    getConnectionByNodeId,
}                           = require('./client_connections.js');
const UserInterruptQueue    = require('./user_interrupt_queue.js');

//  deps
const series            = require('async/series');
const _                 = require('lodash');

exports.moduleInfo = {
    name    : 'Node Message',
    desc    : 'Multi-node messaging',
    author  : 'NuSkooler',
};

const FormIds = {
    sendMessage : 0,
};

const MciViewIds = {
    sendMessage : {
        nodeSelect          : 1,
        message             : 2,
        preview             : 3,

        customRangeStart    : 10,
    }
}

exports.getModule = class NodeMessageModule extends MenuModule {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, _.get(options, 'menuConfig.config'), { extraArgs : options.extraArgs });

        this.menuMethods = {
            sendMessage : (formData, extraArgs, cb) => {
                const nodeId    = formData.value.node;
                const message   = formData.value.message;

                const interruptItem = {
                    contents    : message,
                }

                if(0 === nodeId) {
                    //  ALL nodes
                    UserInterruptQueue.queueGlobalOtherActive(interruptItem, this.client);
                } else {
                    UserInterruptQueue.queueGlobal(interruptItem, [ getConnectionByNodeId(nodeId) ]);
                }

                return this.prevMenu(cb);
            },
        }
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if(err) {
                return cb(err);
            }

            series(
                [
                    (next) => {
                        return this.prepViewController('sendMessage', FormIds.sendMessage, mciData.menu, next);
                    },
                    (next) => {
                        const nodeSelectView = this.viewControllers.sendMessage.getView(MciViewIds.sendMessage.nodeSelect);
                        if(!nodeSelectView) {
                            return next(Errors.MissingMci(`Missing node selection MCI ${MciViewIds.sendMessage.nodeSelect}`));
                        }

                        this.prepareNodeList();

                        nodeSelectView.on('index update', idx => {
                            this.nodeListSelectionIndexUpdate(idx);
                        });

                        nodeSelectView.setItems(this.nodeList);
                        nodeSelectView.redraw();
                        this.nodeListSelectionIndexUpdate(0);
                        return next(null);
                    }
                ],
                err => {
                    return cb(err);
                }
            );
        });
    }

    prepareNodeList() {
        //  standard node list with {text} field added for compliance
        this.nodeList = [{
            text            :  '-ALL-',
            //  dummy fields:
            node            : 0,
            authenticated   : false,
            userId          : 0,
            action          : 'N/A',
            userName        : 'Everyone',
            realName        : 'All Users',
            location        : 'N/A',
            affils          : 'N/A',
            timeOn          : 'N/A',
        }].concat(getActiveNodeList(true)
            .map(node => Object.assign(node, { text : node.node.toString() } ))
        ).filter(node => node.node !== this.client.node);   //  remove our client's node
        this.nodeList.sort( (a, b) => a.node - b.node );    //  sort by node
    }

    nodeListSelectionIndexUpdate(idx) {
        const node = this.nodeList[idx];
        if(!node) {
            return;
        }
        this.updateCustomViewTextsWithFilter('sendMessage', MciViewIds.sendMessage.customRangeStart, node);
    }
}
/* jslint node: true */
'use strict';

const View = require('./view.js').View;
const valueWithDefault = require('./misc_util.js').valueWithDefault;
const isPrintable = require('./string_util.js').isPrintable;
const stylizeString = require('./string_util.js').stylizeString;

const _ = require('lodash');

module.exports = class KeyEntryView extends View {
    constructor(options) {
        options.acceptsFocus = valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = valueWithDefault(options.acceptsInput, true);

        super(options);

        this.eatTabKey = options.eatTabKey || true;
        this.caseInsensitive = options.caseInsensitive || true;

        if (Array.isArray(options.keys)) {
            if (this.caseInsensitive) {
                this.keys = options.keys.map(k => k.toUpperCase());
            } else {
                this.keys = options.keys;
            }
        }
    }

    onKeyPress(ch, key) {
        const drawKey = ch;

        if (ch && this.caseInsensitive) {
            ch = ch.toUpperCase();
        }

        if (
            drawKey &&
            isPrintable(drawKey) &&
            (!this.keys || this.keys.indexOf(ch) > -1)
        ) {
            this.redraw(); //  sets position
            this.client.term.write(stylizeString(ch, this.textStyle));
        }

        this.keyEntered = ch || key.name;

        if (key && 'tab' === key.name && !this.eatTabKey) {
            return this.emit('action', 'next', key);
        }

        this.emit('action', 'accept');
        //  NOTE: we don't call super here. KeyEntryView is a special snowflake.
    }

    setPropertyValue(propName, propValue) {
        switch (propName) {
            case 'eatTabKey':
                if (_.isBoolean(propValue)) {
                    this.eatTabKey = propValue;
                }
                break;

            case 'caseInsensitive':
                if (_.isBoolean(propValue)) {
                    this.caseInsensitive = propValue;
                }
                break;

            case 'keys':
                if (Array.isArray(propValue)) {
                    this.keys = propValue;
                }
                break;
        }

        super.setPropertyValue(propName, propValue);
    }

    getData() {
        return this.keyEntered;
    }
};

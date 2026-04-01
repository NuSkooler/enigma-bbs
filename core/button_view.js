'use strict';

const { TextView } = require('./text_view.js');
const miscUtil = require('./misc_util.js');

const { isString } = require('lodash');

class ButtonView extends TextView {
    constructor(options) {
        options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
        options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);
        options.justify = miscUtil.valueWithDefault(options.justify, 'center');
        options.cursor = miscUtil.valueWithDefault(options.cursor, 'hide');

        super(options);

        this.initDefaultWidth();
    }

    onKeyPress(ch, key) {
        if (this.isKeyMapped('accept', key ? key.name : ch) || ' ' === ch) {
            this.submitData = 'accept';
            this.emit('action', 'accept');
            delete this.submitData;
        } else {
            super.onKeyPress(ch, key);
        }
    }

    getData() {
        return this.submitData || null;
    }

    setPropertyValue(propName, value) {
        switch (propName) {
            case 'itemFormat':
            case 'focusItemFormat':
                if (isString(value)) {
                    this[propName] = value;
                }
                break;
        }

        super.setPropertyValue(propName, value);
    }
}

exports.ButtonView = ButtonView;

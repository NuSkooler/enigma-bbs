'use strict';

//  ENiGMA½
const { TextView } = require('./text_view.js');

class StatusBarView extends TextView {
    constructor(options) {
        super(options);

        //  Keep the raw format template separately so we can re-render it
        //  on each refresh tick (e.g. to pick up a new {CT} value).
        this._format         = options.text || '';
        this.refreshInterval = parseInt(options.refreshInterval, 10) || 0;
        this._timer          = null;

        if (this.refreshInterval > 0) {
            this._startRefresh();
        }
    }

    _startRefresh() {
        this._timer = setInterval(() => {
            //  Process the format template without triggering a redraw yet,
            //  so we can compare the result against the last rendered value.
            this.setText(this._format, false);
            if (this.text !== this._lastRendered) {
                this._lastRendered = this.text;
                this.redraw();
            }
        }, this.refreshInterval);
    }

    setPropertyValue(propName, value) {
        if (propName === 'text') {
            //  Intercept to keep _format in sync before passing to TextView.
            this._format = value || '';
        } else if (propName === 'refreshInterval') {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this.refreshInterval = parseInt(value, 10) || 0;
            if (this.refreshInterval > 0) {
                this._startRefresh();
            }
        }

        super.setPropertyValue(propName, value);
    }

    destroy() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }
}

exports.StatusBarView = StatusBarView;

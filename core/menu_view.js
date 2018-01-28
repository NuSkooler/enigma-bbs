/* jslint node: true */
'use strict';

//	ENiGMA½
const View			= require('./view.js').View;
const miscUtil		= require('./misc_util.js');
const pipeToAnsi	= require('./color_codes.js').pipeToAnsi;

//	deps
const util			= require('util');
const assert		= require('assert');
const _				= require('lodash');

exports.MenuView	= MenuView;

function MenuView(options) {
	options.acceptsFocus = miscUtil.valueWithDefault(options.acceptsFocus, true);
	options.acceptsInput = miscUtil.valueWithDefault(options.acceptsInput, true);

	View.call(this, options);

	this.disablePipe = options.disablePipe || false;

	const self = this;

	if(options.items) {
		this.setItems(options.items);
	} else {
		this.items = [];
	}

	this.caseInsensitiveHotKeys = miscUtil.valueWithDefault(options.caseInsensitiveHotKeys, true);

	this.setHotKeys(options.hotKeys);

	this.focusedItemIndex = options.focusedItemIndex || 0;
	this.focusedItemIndex = this.items.length >= this.focusedItemIndex ? this.focusedItemIndex : 0;

	this.itemSpacing	= _.isNumber(options.itemSpacing) ? options.itemSpacing : 0;

	//	:TODO: probably just replace this with owner draw / pipe codes / etc. more control, less specialization
	this.focusPrefix	= options.focusPrefix || '';
	this.focusSuffix	= options.focusSuffix || '';

	this.fillChar		= miscUtil.valueWithDefault(options.fillChar, ' ').substr(0, 1);
	this.justify		= options.justify || 'none';

	this.hasFocusItems = function() {
		return !_.isUndefined(self.focusItems);
	};

	this.getHotKeyItemIndex = function(ch) {
		if(ch && self.hotKeys) {
			const keyIndex = self.hotKeys[self.caseInsensitiveHotKeys ? ch.toLowerCase() : ch];
			if(_.isNumber(keyIndex)) {
				return keyIndex;
			}
		}
		return -1;
	};
}

util.inherits(MenuView, View);

MenuView.prototype.setItems = function(items) {
	if(Array.isArray(items)) {
		//
		//	Items can be an array of strings or an array of objects.
		//
		//	In the case of objects, items are considered complex and
		//	may have one or more members that can later be formatted
		//	against. The default member is 'text'. The member 'data'
		//	may be overridden to provide a form value other than the
		//	item's index.
		//
		//	Items can be formatted with 'itemFormat' and 'focusItemFormat'
		//
		let text;
		let stringItem;
		this.items = items.map(item => {
			stringItem = _.isString(item);
			if(stringItem) {
				text = item;
			} else {
				text = item.text || '';
				this.complexItems = true;
			}

			text = this.disablePipe ? text : pipeToAnsi(text, this.client);
			return Object.assign({ }, { text }, stringItem ? {} : item);	//	ensure we have a text member, plus any others
		});

		if(this.complexItems) {
			this.itemFormat			= this.itemFormat || '{text}';
			this.focusItemFormat	= this.focusItemFormat || this.itemFormat;
		}
	}
};

MenuView.prototype.removeItem = function(index) {
	this.items.splice(index, 1);

	if(this.focusItems) {
		this.focusItems.splice(index, 1);
	}

	if(this.focusedItemIndex >= index) {
		this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
	}

	this.positionCacheExpired = true;
};

MenuView.prototype.getCount = function() {
	return this.items.length;
};

MenuView.prototype.getItems = function() {
	if(this.complexItems) {
		return this.items;
	}

	return this.items.map( item => {
		return item.text;
	});
};

MenuView.prototype.getItem = function(index) {
	if(this.complexItems) {
		return this.items[index];
	}

	return this.items[index].text;
};

MenuView.prototype.focusNext = function() {
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.focusPrevious = function() {
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.focusNextPageItem = function() {
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.focusPreviousPageItem = function() {
	this.emit('index update', this.focusedItemIndex);
};

MenuView.prototype.setFocusItemIndex = function(index) {
	this.focusedItemIndex = index;
};

MenuView.prototype.onKeyPress = function(ch, key) {
	const itemIndex = this.getHotKeyItemIndex(ch);
	if(itemIndex >= 0) {
		this.setFocusItemIndex(itemIndex);

		if(true === this.hotKeySubmit) {
			this.emit('action', 'accept');
		}
	}

	MenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

MenuView.prototype.setFocusItems = function(items) {
	const self = this;

	if(items) {
		this.focusItems = [];
		items.forEach( itemText => {
			this.focusItems.push(
				{
					text : self.disablePipe ? itemText : pipeToAnsi(itemText, self.client)
				}
			);
		});
	}
};

MenuView.prototype.setItemSpacing = function(itemSpacing) {
	itemSpacing = parseInt(itemSpacing);
	assert(_.isNumber(itemSpacing));

	this.itemSpacing			= itemSpacing;
	this.positionCacheExpired	= true;
};

MenuView.prototype.setPropertyValue = function(propName, value) {
	switch(propName) {
		case 'itemSpacing' 		: this.setItemSpacing(value); break;
		case 'items'			: this.setItems(value); break;
		case 'focusItems'		: this.setFocusItems(value); break;
		case 'hotKeys'			: this.setHotKeys(value); break;
		case 'hotKeySubmit'		: this.hotKeySubmit = value; break;
		case 'justify'			: this.justify = value; break;
		case 'focusItemIndex'	: this.focusedItemIndex = value; break;

		case 'itemFormat' :
		case 'focusItemFormat' :
			this[propName] = value;
			break;
	}

	MenuView.super_.prototype.setPropertyValue.call(this, propName, value);
};

MenuView.prototype.setHotKeys = function(hotKeys) {
	if(_.isObject(hotKeys)) {
		if(this.caseInsensitiveHotKeys) {
			this.hotKeys = {};
			for(var key in hotKeys) {
				this.hotKeys[key.toLowerCase()] = hotKeys[key];
			}
		} else {
			this.hotKeys = hotKeys;
		}
	}
};


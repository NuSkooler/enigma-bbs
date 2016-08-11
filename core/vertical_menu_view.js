/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuView		= require('./menu_view.js').MenuView;
const ansi			= require('./ansi_term.js');
const strUtil		= require('./string_util.js');
const colorCodes	= require('./color_codes.js');

//	deps
const util			= require('util');

exports.VerticalMenuView		= VerticalMenuView;

function VerticalMenuView(options) {
	options.cursor	= options.cursor || 'hide';
	options.justify = options.justify || 'right';	//	:TODO: default to center
	
	MenuView.call(this, options);

	const self = this;

	this.performAutoScale = function() {
		if(this.autoScale.height) {
			this.dimens.height = (self.items.length * (self.itemSpacing + 1)) - (self.itemSpacing);
			this.dimens.height = Math.min(self.dimens.height, self.client.term.termHeight - self.position.row);
		}

		if(self.autoScale.width) {
			let maxLen = 0;
			self.items.forEach( item => {
				if(item.text.length > maxLen) {
					maxLen = Math.min(item.text.length, self.client.term.termWidth - self.position.col);
				}
			});
			self.dimens.width = maxLen + 1;
		}
	};

	this.performAutoScale();

	this.updateViewVisibleItems = function() {
		self.maxVisibleItems = Math.ceil(self.dimens.height / (self.itemSpacing + 1));

		self.viewWindow = {
			top		: self.focusedItemIndex,
			bottom	: Math.min(self.focusedItemIndex + self.maxVisibleItems, self.items.length) - 1
		};
	};

	this.drawItem = function(index) {
		const item = self.items[index];
		if(!item) {
			return;
		}

		let text;
		let sgr;
		if(item.focused && self.hasFocusItems()) {
			const focusItem = self.focusItems[index];
			text = strUtil.stylizeString(
				focusItem ? focusItem.text : item.text,
				self.textStyle
			);
			sgr = '';
		} else {
			text = strUtil.stylizeString(item.text, self.textStyle);
			sgr = (index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR());
		}

		text += self.getSGR();

		self.client.term.write(
			ansi.goto(item.row, self.position.col) +
			sgr + 
			strUtil.pad(text, this.dimens.width, this.fillChar, this.justify)
		);
	};
}

util.inherits(VerticalMenuView, MenuView);

VerticalMenuView.prototype.redraw = function() {
	VerticalMenuView.super_.prototype.redraw.call(this);	

	//	:TODO: rename positionCacheExpired to something that makese sense; combine methods for such
	if(this.positionCacheExpired) {
		this.performAutoScale();
		this.updateViewVisibleItems();

		this.positionCacheExpired = false;
	}

	//	erase old items
	//	:TODO: optimize this: only needed if a item is removed or new max width < old.
	if(this.oldDimens) {
		const blank 	= new Array(Math.max(this.oldDimens.width, this.dimens.width)).join(' ');
		let seq			= ansi.goto(this.position.row, this.position.col) + this.getSGR() + blank;
		let row			= this.position.row + 1;
		const endRow	= (row + this.oldDimens.height) - 2;
		
		while(row < endRow) {
			seq += ansi.goto(row, this.position.col) + blank;
			row += 1;
		}
		this.client.term.write(seq);
		delete this.oldDimens;
	}	

	let row = this.position.row;
	for(let i = this.viewWindow.top; i <= this.viewWindow.bottom; ++i) {
		this.items[i].row = row;
		row += this.itemSpacing + 1;
		this.items[i].focused = this.focusedItemIndex === i;
		this.drawItem(i);
	}
};

VerticalMenuView.prototype.setHeight = function(height) {
	VerticalMenuView.super_.prototype.setHeight.call(this, height);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setPosition = function(pos) {
	VerticalMenuView.super_.prototype.setPosition.call(this, pos);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setFocus = function(focused) {
	VerticalMenuView.super_.prototype.setFocus.call(this, focused);

	this.redraw();
};

VerticalMenuView.prototype.setFocusItemIndex = function(index) {
	VerticalMenuView.super_.prototype.setFocusItemIndex.call(this, index);	//	sets this.focusedItemIndex

	const remainAfterFocus = this.items.length - index;
	if(remainAfterFocus >= this.maxVisibleItems) {
		this.viewWindow = {
			top		: this.focusedItemIndex,
			bottom	: Math.min(this.focusedItemIndex + this.maxVisibleItems, this.items.length) - 1
		};

		this.positionCacheExpired = false;	//	skip standard behavior
		this.performAutoScale();
	}

	this.redraw();
};

VerticalMenuView.prototype.onKeyPress = function(ch, key) {

	if(key) {
		if(this.isKeyMapped('up', key.name)) {
			this.focusPrevious();
		} else if(this.isKeyMapped('down', key.name)) {
			this.focusNext();
		}
	}

	VerticalMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

VerticalMenuView.prototype.getData = function() {
	return this.focusedItemIndex;
};

VerticalMenuView.prototype.setItems = function(items) {
	//	if we have items already, save off their drawing area so we don't leave fragments at redraw
	if(this.items && this.items.length) {
		this.oldDimens = this.dimens;
	}

	VerticalMenuView.super_.prototype.setItems.call(this, items);

	this.positionCacheExpired = true;
};

//	:TODO: Apply draw optimizaitons when only two items need drawn vs entire view!

VerticalMenuView.prototype.focusNext = function() {
	if(this.items.length - 1 === this.focusedItemIndex) {
		this.focusedItemIndex = 0;
		
		this.viewWindow = {
			top		: 0,
			bottom	: Math.min(this.maxVisibleItems, this.items.length) - 1
		};
	} else {
		this.focusedItemIndex++;

		if(this.focusedItemIndex > this.viewWindow.bottom) {
			this.viewWindow.top++;
			this.viewWindow.bottom++;
		}
	}

	this.redraw();

	VerticalMenuView.super_.prototype.focusNext.call(this);
};

VerticalMenuView.prototype.focusPrevious = function() {
	if(0 === this.focusedItemIndex) {
		this.focusedItemIndex = this.items.length - 1;
		
		this.viewWindow = {
			//top		: this.items.length - this.maxVisibleItems,
			top		: Math.max(this.items.length - this.maxVisibleItems, 0),
			bottom	: this.items.length - 1
		};

	} else {
		this.focusedItemIndex--;

		if(this.focusedItemIndex < this.viewWindow.top) {
			this.viewWindow.top--;
			this.viewWindow.bottom--;

			//	adjust for focus index being set & window needing expansion as we scroll up
			const rem = (this.viewWindow.bottom - this.viewWindow.top) + 1;
			if(rem < this.maxVisibleItems && (this.items.length - 1) > this.focusedItemIndex) {
				this.viewWindow.bottom = this.items.length - 1;
			}
		}
	}

	this.redraw();

	VerticalMenuView.super_.prototype.focusPrevious.call(this);
};


VerticalMenuView.prototype.setFocusItems = function(items) {
	VerticalMenuView.super_.prototype.setFocusItems.call(this, items);

	this.positionCacheExpired = true;
};

VerticalMenuView.prototype.setItemSpacing = function(itemSpacing) {
	VerticalMenuView.super_.prototype.setItemSpacing.call(this, itemSpacing);

	this.positionCacheExpired = true;
};
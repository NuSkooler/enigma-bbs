/* jslint node: true */
'use strict';

//  ENiGMA½
const MenuView = require('./menu_view.js').MenuView;
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const pipeToAnsi = require('./color_codes.js').pipeToAnsi;

//  deps
const util = require('util');
const _ = require('lodash');

exports.FullMenuView = FullMenuView;

function FullMenuView(options) {
  options.cursor = options.cursor || 'hide';
  options.justify = options.justify || 'left';


  MenuView.call(this, options);

  this.initDefaultWidth();

  const self = this;

  //  we want page up/page down by default
  if (!_.isObject(options.specialKeyMap)) {
    Object.assign(this.specialKeyMap, {
      'page up': ['page up'],
      'page down': ['page down'],
    });
  }

  this.autoAdjustHeightIfEnabled = function() {
    if (this.autoAdjustHeight) {
      this.dimens.height = (this.items.length * (this.itemSpacing + 1)) - (this.itemSpacing);
      this.dimens.height = Math.min(this.dimens.height, this.client.term.termHeight - this.position.row);
    }

    // Calculate number of items visible after adjusting height
    this.itemsPerRow = Math.floor(this.dimens.height / (this.itemSpacing + 1));
    // handle case where one can fit at the end
    if (this.dimens.height > (this.itemsPerRow * (this.itemSpacing + 1))) {
      this.itemsPerRow++;
    }

    // Final check to make sure we don't try to display more than we have
    if (this.itemsPerRow > this.items.length) {
      this.itemsPerRow = this.items.length;
    }

  };

  this.autoAdjustHeightIfEnabled();

  this.getSpacer = function() {
    return new Array(self.itemHorizSpacing + 1).join(this.fillChar);
  }

  this.cachePositions = function() {
    if (this.positionCacheExpired) {
      this.autoAdjustHeightIfEnabled();

      var col = self.position.col;
      var row = self.position.row;
      var spacer = self.getSpacer();

      var itemInRow = 0;

      for (var i = 0; i < self.items.length; ++i) {
        itemInRow++;
        self.items[i].row = row;
        self.items[i].col = col;

        row += this.itemSpacing + 1;

        // handle going to next column
        if (itemInRow == this.itemsPerRow) {
          itemInRow = 0;

          row = self.position.row;
          var maxLength = 0;
          for (var j = 0; j < this.itemsPerRow; j++) {
            // TODO: handle complex items
            var itemLength = this.items[i - j].text.length;
            if (itemLength > maxLength) {
              maxLength = itemLength;
            }
          }

          // set length on each item in the column
          for (var j = 0; j < this.itemsPerRow; j++) {
            self.items[i - j].fixedLength = maxLength;
          }

          // increment the column
          col += maxLength + spacer.length + 1;
        }

        // also have to calculate the max length on the last column
        else if (i == self.items.length - 1) {
          var maxLength = 0;
          for (var j = 0; j < this.itemsPerRow; j++) {
            if (self.items[i - j].col != self.items[i].col) {
              break;
            }
            var itemLength = this.items[i - j].text.length;
            if (itemLength > maxLength) {
              maxLength = itemLength;
            }
          }

          // set length on each item in the column
          for (var j = 0; j < this.itemsPerRow; j++) {
            if (self.items[i - j].col != self.items[i].col) {
              break;
            }
            self.items[i - j].fixedLength = maxLength;
          }

        }
      }
    }

    this.positionCacheExpired = false;
  };

  this.drawItem = function(index) {
    const item = self.items[index];
    if (!item) {
      return;
    }

    const cached = this.getRenderCacheItem(index, item.focused);
    if (cached) {
      return self.client.term.write(`${ansi.goto(item.row, item.col)}${cached}`);
    }

    let text;
    let sgr;
    if (item.focused && self.hasFocusItems()) {
      const focusItem = self.focusItems[index];
      text = focusItem ? focusItem.text : item.text;
      sgr = '';
    } else if (this.complexItems) {
      text = pipeToAnsi(formatString(item.focused && this.focusItemFormat ? this.focusItemFormat : this.itemFormat, item));
      sgr = this.focusItemFormat ? '' : (index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR());
    } else {
      text = strUtil.stylizeString(item.text, item.focused ? self.focusTextStyle : self.textStyle);
      sgr = (index === self.focusedItemIndex ? self.getFocusSGR() : self.getSGR());
    }

    text = `${sgr}${strUtil.pad(text, this.dimens.width, this.fillChar, this.justify)}`;
    self.client.term.write(`${ansi.goto(item.row, item.col)}${text}`);
    this.setRenderCacheItem(index, text, item.focused);
  };
}

util.inherits(FullMenuView, MenuView);


FullMenuView.prototype.redraw = function() {
  FullMenuView.super_.prototype.redraw.call(this);

  this.cachePositions();

  //  :TODO: rename positionCacheExpired to something that makese sense; combine methods for such
  if (this.positionCacheExpired) {
    this.autoAdjustHeightIfEnabled();
    this.positionCacheExpired = false;
  }

  //  erase old items
  //  :TODO: optimize this: only needed if a item is removed or new max width < old.
  if (this.oldDimens) {
    const blank = new Array(Math.max(this.oldDimens.width, this.dimens.width)).join(' ');
    let seq = ansi.goto(this.position.row, this.position.col) + this.getSGR() + blank;
    let row = this.position.row + 1;
    const endRow = (row + this.oldDimens.height) - 2;

    while (row <= endRow) {
      seq += ansi.goto(row, this.position.col) + blank;
      row += 1;
    }
    this.client.term.write(seq);
    delete this.oldDimens;
  }

  if (this.items.length) {
    for (let i = 0; i < this.items.length; ++i) {
      this.items[i].focused = this.focusedItemIndex === i;
      this.drawItem(i);
    }
  }
};

FullMenuView.prototype.setHeight = function(height) {
  FullMenuView.super_.prototype.setHeight.call(this, height);

  this.positionCacheExpired = true;
  this.autoAdjustHeight = false;
};

FullMenuView.prototype.setPosition = function(pos) {
  FullMenuView.super_.prototype.setPosition.call(this, pos);

  this.positionCacheExpired = true;
};

FullMenuView.prototype.setFocus = function(focused) {
  FullMenuView.super_.prototype.setFocus.call(this, focused);

  this.redraw();
};

FullMenuView.prototype.setFocusItemIndex = function(index) {
  FullMenuView.super_.prototype.setFocusItemIndex.call(this, index);  //  sets this.focusedItemIndex

  this.redraw();
};

FullMenuView.prototype.onKeyPress = function(ch, key) {
  if (key) {
    if (this.isKeyMapped('up', key.name)) {
      this.focusPrevious();
    } else if (this.isKeyMapped('down', key.name)) {
      this.focusNext();
    } else if (this.isKeyMapped('left', key.name)) {
      this.focusPreviousColumn();
    } else if (this.isKeyMapped('right', key.name)) {
      this.focusNextColumn();
    } else if (this.isKeyMapped('page up', key.name)) {
      this.focusPreviousPageItem();
    } else if (this.isKeyMapped('page down', key.name)) {
      this.focusNextPageItem();
    } else if (this.isKeyMapped('home', key.name)) {
      this.focusFirst();
    } else if (this.isKeyMapped('end', key.name)) {
      this.focusLast();
    }
  }

  FullMenuView.super_.prototype.onKeyPress.call(this, ch, key);
};

FullMenuView.prototype.getData = function() {
  const item = this.getItem(this.focusedItemIndex);
  return _.isString(item.data) ? item.data : this.focusedItemIndex;
};

FullMenuView.prototype.setItems = function(items) {
  //  if we have items already, save off their drawing area so we don't leave fragments at redraw
  if (this.items && this.items.length) {
    this.oldDimens = Object.assign({}, this.dimens);
  }

  FullMenuView.super_.prototype.setItems.call(this, items);

  this.positionCacheExpired = true;
};

FullMenuView.prototype.removeItem = function(index) {
  if (this.items && this.items.length) {
    this.oldDimens = Object.assign({}, this.dimens);
  }

  FullMenuView.super_.prototype.removeItem.call(this, index);
};

//  :TODO: Apply draw optimizaitons when only two items need drawn vs entire view!

FullMenuView.prototype.focusNext = function() {
  if (this.items.length - 1 === this.focusedItemIndex) {
    this.focusedItemIndex = 0;

  } else {
    this.focusedItemIndex++;

  }

  this.redraw();

  FullMenuView.super_.prototype.focusNext.call(this);
};

FullMenuView.prototype.focusPrevious = function() {
  if (0 === this.focusedItemIndex) {
    this.focusedItemIndex = this.items.length - 1;


  } else {
    this.focusedItemIndex--;
  }

  this.redraw();

  FullMenuView.super_.prototype.focusPrevious.call(this);
};

FullMenuView.prototype.focusPreviousColumn = function() {

  this.focusedItemIndex = this.focusedItemIndex - this.itemsPerRow;
  if (this.focusedItemIndex < 0) {
    // add the negative index to the end of the list
    this.focusedItemIndex = this.items.length + this.focusedItemIndex;
  }

  this.redraw();

  // TODO: This isn't specific to Previous, may want to replace in the future
  FullMenuView.super_.prototype.focusPrevious.call(this);
};

FullMenuView.prototype.focusNextColumn = function() {

  this.focusedItemIndex = this.focusedItemIndex + this.itemsPerRow;
  if (this.focusedItemIndex > this.items.length - 1) {
    // add the overflow to the beginning of the list
    this.focusedItemIndex = this.focusedItemIndex - this.items.length;
  }

  this.redraw();

  // TODO: This isn't specific to Next, may want to replace in the future
  FullMenuView.super_.prototype.focusNext.call(this);
};


FullMenuView.prototype.focusPreviousPageItem = function() {
  //
  //  Jump to current - up to page size or top
  //  If already at the top, jump to bottom
  //
  if (0 === this.focusedItemIndex) {
    return this.focusPrevious();    //  will jump to bottom
  }

  const index = Math.max(this.focusedItemIndex - this.dimens.height, 0);

  this.setFocusItemIndex(index);

  return FullMenuView.super_.prototype.focusPreviousPageItem.call(this);
};

FullMenuView.prototype.focusNextPageItem = function() {
  //
  //  Jump to current + up to page size or bottom
  //  If already at the bottom, jump to top
  //
  if (this.items.length - 1 === this.focusedItemIndex) {
    return this.focusNext();    //  will jump to top
  }

  const index = Math.min(this.focusedItemIndex + this.maxVisibleItems, this.items.length - 1);

  this.setFocusItemIndex(index);

  return FullMenuView.super_.prototype.focusNextPageItem.call(this);
};

FullMenuView.prototype.focusFirst = function() {
  this.setFocusItemIndex(0);
  return FullMenuView.super_.prototype.focusFirst.call(this);
};

FullMenuView.prototype.focusLast = function() {
  const index = this.items.length - 1;

  this.setFocusItemIndex(index);

  return FullMenuView.super_.prototype.focusLast.call(this);
};

FullMenuView.prototype.setFocusItems = function(items) {
  FullMenuView.super_.prototype.setFocusItems.call(this, items);

  this.positionCacheExpired = true;
};

FullMenuView.prototype.setItemSpacing = function(itemSpacing) {
  FullMenuView.super_.prototype.setItemSpacing.call(this, itemSpacing);

  this.positionCacheExpired = true;
};

FullMenuView.prototype.setItemHorizSpacing = function(itemHorizSpacing) {
  FullMenuView.super_.prototype.setItemHorizSpacing.call(this, itemHorizSpacing);

  this.positionCacheExpired = true;
};

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


  // Initialize paging
  this.pages = [];
  this.currentPage = 0;

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

    this.positionCacheExpired = true;
  };

  this.autoAdjustHeightIfEnabled();



  this.getSpacer = function() {
    return new Array(self.itemHorizSpacing + 1).join(this.fillChar);
  }


  this.clearPage = function() {
    for (var i = 0; i < this.dimens.height; i++) {
      let text = `${strUtil.pad(' ', this.dimens.width, this.fillChar, 'left')}`;
      self.client.term.write(`${ansi.goto(this.position.row + i, this.position.col)}${text}`);
    }
  }

  this.cachePositions = function() {
    if (this.positionCacheExpired) {
      this.autoAdjustHeightIfEnabled();

      this.pages = []; // reset

      // Calculate number of items visible per column
      this.itemsPerRow = Math.floor(this.dimens.height / (this.itemSpacing + 1));
      // handle case where one can fit at the end
      if (this.dimens.height > (this.itemsPerRow * (this.itemSpacing + 1))) {
        this.itemsPerRow++;
      }

      // Final check to make sure we don't try to display more than we have
      if (this.itemsPerRow > this.items.length) {
        this.itemsPerRow = this.items.length;
      }

      var col = this.position.col;
      var row = this.position.row;
      var spacer = this.getSpacer();

      var itemInRow = 0;
      var itemInCol = 0;

      var pageStart = 0;

      for (var i = 0; i < this.items.length; ++i) {
        itemInRow++;
        this.items[i].row = row;
        this.items[i].col = col;
        this.items[i].itemInRow = itemInRow;

        row += this.itemSpacing + 1;

        // have to calculate the max length on the last entry
        if (i == this.items.length - 1) {
          var maxLength = 0;
          for (var j = 0; j < this.itemsPerRow; j++) {
            if (this.items[i - j].col != this.items[i].col) {
              break;
            }
            var itemLength = this.items[i - j].text.length;
            if (itemLength > maxLength) {
              maxLength = itemLength;
            }
          }

          // set length on each item in the column
          for (var j = 0; j < this.itemsPerRow; j++) {
            if (this.items[i - j].col != this.items[i].col) {
              break;
            }
            this.items[i - j].fixedLength = maxLength;
          }


          // Check if we have room for this column
          // skip for column 0, we need at least one
          if (itemInCol != 0 && (col + maxLength + spacer.length + 1 > this.position.col + this.dimens.width)) {
            // save previous page
            this.pages.push({ start: pageStart, end: i - this.itemsPerRow });

            // fix the last column processed
            for (var j = 0; j < this.itemsPerRow; j++) {
              if (this.items[i - j].col != col) {
                break;
              }
              this.items[i - j].col = this.position.col;
              pageStart = i - j;
            }

          }

          // Since this is the last page, save the current page as well
          this.pages.push({ start: pageStart, end: i });

        }
        // also handle going to next column
        else if (itemInRow == this.itemsPerRow) {
          itemInRow = 0;

          // restart row for next column
          row = this.position.row;
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
            this.items[i - j].fixedLength = maxLength;
          }

          // Check if we have room for this column in the current page
          // skip for first column, we need at least one
          if (itemInCol != 0 && (col + maxLength > this.position.col + this.dimens.width)) {
            // save previous page
            this.pages.push({ start: pageStart, end: i - this.itemsPerRow });

            // restart page start for next page
            pageStart = i - this.itemsPerRow + 1;

            // reset
            col = this.position.col;
            itemInRow = 0;

            // fix the last column processed
            for (var j = 0; j < this.itemsPerRow; j++) {
              this.items[i - j].col = col;
            }





          }

          // increment the column
          col += maxLength + spacer.length + 1;
          itemInCol++;
        }


        // Set the current page if the current item is focused.
        if (this.focusedItemIndex === i) {
          this.currentPage = this.pages.length;
        }
      }
    }

    this.positionCacheExpired = false;
  };

  this.drawItem = function(index) {
    const item = this.items[index];
    if (!item) {
      return;
    }

    const cached = this.getRenderCacheItem(index, item.focused);
    if (cached) {
      return this.client.term.write(`${ansi.goto(item.row, item.col)}${cached}`);
    }

    let text;
    let sgr;
    if (item.focused && this.hasFocusItems()) {
      const focusItem = this.focusItems[index];
      text = focusItem ? focusItem.text : item.text;
      sgr = '';
    } else if (this.complexItems) {
      text = pipeToAnsi(formatString(item.focused && this.focusItemFormat ? this.focusItemFormat : this.itemFormat, item));
      sgr = this.focusItemFormat ? '' : (index === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR());
    } else {
      text = strUtil.stylizeString(item.text, item.focused ? this.focusTextStyle : this.textStyle);
      sgr = (index === this.focusedItemIndex ? this.getFocusSGR() : this.getSGR());
    }

    let renderLength = strUtil.renderStringLength(text);
    if (this.hasTextOverflow() && (item.col + renderLength) > this.dimens.width) {
      text = strUtil.renderSubstr(text, 0, this.dimens.width - (item.col + this.textOverflow.length)) + this.textOverflow;
    }

    text = `${sgr}${strUtil.pad(text, this.fixedLength, this.fillChar, this.justify)}`;
    this.client.term.write(`${ansi.goto(item.row, item.col)}${text}`);
    this.setRenderCacheItem(index, text, item.focused);
  };
}

util.inherits(FullMenuView, MenuView);


FullMenuView.prototype.redraw = function() {
  FullMenuView.super_.prototype.redraw.call(this);

  this.cachePositions();


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
    for (let i = this.pages[this.currentPage].start; i <= this.pages[this.currentPage].end; ++i) {
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

FullMenuView.prototype.setWidth = function(width) {
  FullMenuView.super_.prototype.setWidth.call(this, width);

  this.positionCacheExpired = true;
};

FullMenuView.prototype.setTextOverflow = function(overflow) {
  FullMenuView.super_.prototype.setTextOverflow.call(this, overflow);

  this.positionCacheExpired = true;

}

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
    this.clearPage();
    this.focusedItemIndex = 0;
    this.currentPage = 0;
  }
  else {
    this.focusedItemIndex++;
    if (this.focusedItemIndex > this.pages[this.currentPage].end) {
      this.clearPage();
      this.currentPage++;
    }
  }

  this.redraw();

  FullMenuView.super_.prototype.focusNext.call(this);
};

FullMenuView.prototype.focusPrevious = function() {
  if (0 === this.focusedItemIndex) {
    this.clearPage();
    this.focusedItemIndex = this.items.length - 1;
    this.currentPage = this.pages.length - 1;
  }
  else {
    this.focusedItemIndex--;
    if (this.focusedItemIndex < this.pages[this.currentPage].start) {
      this.clearPage();
      this.currentPage--;
    }
  }

  this.redraw();

  FullMenuView.super_.prototype.focusPrevious.call(this);
};

FullMenuView.prototype.focusPreviousColumn = function() {

  var currentRow = this.items[this.focusedItemIndex].itemInRow;
  this.focusedItemIndex = this.focusedItemIndex - this.itemsPerRow;
  if (this.focusedItemIndex < 0) {
    this.clearPage();
    var lastItemRow = this.items[this.items.length - 1].itemInRow;
    if (lastItemRow > currentRow) {
      this.focusedItemIndex = this.items.length - (lastItemRow - currentRow) - 1;
    }
    else {
      // can't go to same column, so go to last item
      this.focusedItemIndex = this.items.length - 1;
    }
    // add the negative index to the end of the list
    //    this.focusedItemIndex = this.items.length + this.focusedItemIndex;
    // set to last page
    this.currentPage = this.pages.length - 1;
  }
  else {
    if (this.focusedItemIndex < this.pages[this.currentPage].start) {
      this.clearPage();
      this.currentPage--;
    }
  }

  this.redraw();

  // TODO: This isn't specific to Previous, may want to replace in the future
  FullMenuView.super_.prototype.focusPrevious.call(this);
};

FullMenuView.prototype.focusNextColumn = function() {

  var currentRow = this.items[this.focusedItemIndex].itemInRow;
  this.focusedItemIndex = this.focusedItemIndex + this.itemsPerRow;
  if (this.focusedItemIndex > this.items.length - 1) {
    this.focusedItemIndex = currentRow - 1;
    this.currentPage = 0;
    this.clearPage();
  }
  else if (this.focusedItemIndex > this.pages[this.currentPage].end) {
    this.clearPage();
    this.currentPage++;
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

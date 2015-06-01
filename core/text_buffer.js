
var _		= require('lodash');

exports.TextBuffer	= TextBuffer;

/*
* gap buffer of objects
* Single buffer for actual/render
* Preserve original line endings if possible
* object has text
* standard whitespace are just objects
* tabs are special objects
* hard line feeds are recorded
* cursor always at currentSpan / object


*/

function TextBuferFragment(options) {
	if(_.isString(options)) {
		this.text = options;
	} else {
		this.text = options.text || '';
	}

	var self = this;

	this.isTab = function() {
		return '\t' === self.text;
	};

	this.isWhitespace = function() {
		return self.text.match(/\s+/g) ? true : false;
	};

	Object.defineProperty(this, 'length', {
		enumerable : true,
		get : function() {
			return this.text.length;
		},
	});
}

function TextBuffer(options) {
	
	this.gapSize	= options.gapSize || 64;
	this.buffer		= new Array(this.gapSize);
	this.gapStart	= 0;
	this.gapEnd		= this.gapSize;
	this.spliceArgs	= new Array(this.gapSize + 2);


	var self		= this;

	Object.defineProperty(this, 'length', {
		enumerable : true,
		get : function() {
			return this.buffer.length - (this.gapEnd - this.gapSize);
		},
	});

	this.adjustGap = function(index) {
		var gapSize	= (self.gapEnd - self.gapStart);
		var delta;
		var i;

		if(index < self.gapStart) {
			delta = self.gapStart - index;	

			for(i = delta - 1; i >= 0; --i) {
				self.buffer[self.gapEnd - delta + i] = self.buffer[index + i];
			}

			self.gapStart	-= delta;
			self.gapEnd		-= delta;
		} else if(index > self.gapStart) {
			delta = index - self.gapStart;

			for(i = 0; i < delta; ++i) {
				self.buffer[self.gapStart + i] = self.buffer[self.gapEnd + i];
			}

			self.gapStart	+= delta;
			self.gapEnd		+= delta;
		}
	};
}

TextBuffer.prototype.get = function(index) {
	if(index >= this.length) {
		return undefined;
	}

	if(index >= this.gapStart) {
		index += (this.gapEnd - this.gapStart);
	}

	return this.buffer[index];
};

TextBuffer.prototype.insertFragment = function(index, fragment) {
	if(index < 0) {
		throw new RangeError('Index must be >= 0');
	}

	if(index > this.length) {
		throw new RangeError('Index must be <= length');
	}

	if(this.gapStart === this.gapEnd) {
		this.spliceArgs[0] = index;
		this.spliceArgs[1] = 0;

		Array.prototype.splice.apply(this.buffer, this.spliceArgs);

		this.gapStart	= index;
		this.gapEnd		= index + this.gapSize;
	} else {
		this.adjustGap(index);
	}

	this.buffer[this.gapStart++] = fragment;
};

TextBuffer.prototype.insertText = function(index, text) {
	//
	//	Create fragments from text. Each fragment is:
	//	*	A series of whitespace(s)
	//	*	A tab
	//	*	Printable characters
	//
	//	A fragment may also have various flags set
	//	for eol markers. These are always normalized
	//	to a single *nix style \n
	//
	if(0 === text.length) {
		return;
	}

	var re = /\s+|\r\n|\n|\r/g;
	var m;
	var i = index;
	var from;
	do {		
		from	= re.lastIndex + (_.isObject(m) ? m[0].length - 1 : 0);		
		m		= re.exec(text);
		if(null !== m) {

			this.insertFragment(i++, new TextBuferFragment({
				text : text.substring(from, re.lastIndex)
			}));

			switch(m[0].charAt(0)) {
				case '\t' :
					for(var j = 0; j < m[0].length; ++j) {
						this.insertFragment(i++, new TextBuffer({
							text : m[0].charAt(j)
						}));
					}
				break;

				case '\r' :
				case '\n' :
					var count = m[0].split(/\r\n|\n|\r/g).length;
					for(var j = 0; j < count; ++j) {
						this.insertFragment(i++, new TextBuffer({
							text : '\n'	//	always normalized
						}));
					}
				break;

				case ' ' :
					this.insertFragment(i++, new TextBuffer({
						text : m[0],
					}));
				break;
			}		
		}
	} while(0 !== re.lastIndex);
};

TextBuffer.prototype.getArray = function() {
	return this.buffer.slice(0, this.gapStart).concat(this.buffer.slice(this.gapEnd));
};

TextBuffer.prototype.getText = function(range) {

};
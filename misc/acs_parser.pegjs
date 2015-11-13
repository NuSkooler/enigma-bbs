
{
	var client	= options.client;
	var user	= options.client.user;

	var _		= require('lodash');

	function checkAccess(name, value) {
		try {
			return {
				'='	: function isLocalConnection() {
					return client.isLocal();
				},
				A	: function ageGreaterOrEqualThan() {
					return !isNaN(value) && user.getAge() >= value;
				},
				EC	: function isEncoding() {
					switch(value) {
						case 0	: return 'cp437' === client.term.outputEncoding.toLowerCase();
						case 1	: return 'utf-8' === client.term.outputEncoding.toLowerCase();
						default	: return false;
					}
				},
				GM	: function isOneOfGroups() {
					if(!_.isArray(value)) {
						return false;
					}

					value.forEach(function grpEntry(groupName) {
						if(user.isGroupMember(groupName)) {
							return true;
						}
					});

					return false;
				},
				N	: function isNode() {
					return client.node === value;
				},
				P	: function numberOfPosts() {
					//	:TODO: implement me!!!!
					return false;
				},
				Q	: function numberOfCalls() {
					//	:TODO: implement me!!
					return false;
				},
				SC 	: function isSecerConnection() {
					return client.session.isSecure;
				},
				T	: function minutesLeft() {
					//	:TODO: implement me!
					return false;
				},
				TH	: function termHeight() {
					return !isNaN(value) && client.term.termHeight >= value;
				},
				TM	: function isOneOfThemes() {
					if(!_.isArray(value)) {
						return false;
					}

					return value.indexOf(client.currentTheme.name) > -1;
				},
				TT	: function isOneOfTermTypes() {
					if(!_.isArray(value)) {
						return false;
					}

					return value.indexOf(client.term.termType) > -1;
				},
				TW	: function termWidth() {
					return !isNaN(value) && client.term.termWidth >= value;
				},
				U	: function isUserId(value) {
					return user.userId === value;
				},
				W	: function isOneOfDayOfWeek() {
					//	:TODO: return true if DoW
					if(_.isNumber(value)) {

					} else if(_.isArray(value)) {

					}
					return false;
				},
				Y	: function isMinutesPastMidnight() {
					//	:TODO: return true if value is >= minutes past midnight sys time
					return false;
				}
			}[name](value);
		} catch (e) {
			client.log.warn( { name : name, value : value }, 'Invalid ACS string!');
			return false;
		}
	}
}

start
	= expr

expr
	= orExpr

OR
	= '|'

AND
	= '&'

NOT
	= '!'

groupOpen
	= '('

groupClose
	= ')'

orExpr
	= left:andExpr OR right:expr { return left || right; }
	/ andExpr

andExpr
	= left:notExpr AND? right:expr { return left && right; }
	/ notExpr

notExpr
	= NOT value:atom { return !value; }
	/ atom

atom
	= acsCheck
	/ groupOpen value:expr groupClose { return value; }

comma
	= ','

ws 
	= ' '

optWs
	= ws*

listOpen
	= '['

listClose
	= ']'

acsCheck
	= n:name a:arg { return checkAccess(n, a); }

name
	= c:([A-Z][A-Z]) { return c.join(''); }
	/ c:[A-Z\=]

argVar
	= a:[A-Za-z0-9\-_\+]+ { return a.join('') }

commaList
	= start:(v:argVar optWs comma optWs { return v; })* last:argVar { return start.concat(last); }

list
	= listOpen l:commaList listClose { return l; }

number
	= d:([0-9]+) { return parseInt(d.join(''), 10); }

arg
	= list
	/ num:number?

 
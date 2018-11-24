
{
	const client	= options.client;
	const user		= options.client.user;

	const UserProps	= require('./user_property.js');

	const moment	= require('moment');

	function checkAccess(acsCode, value) {
		try {
			return {
				LC	: function isLocalConnection() {
					return client.isLocal();
				},
				AG	: function ageGreaterOrEqualThan() {
					return !isNaN(value) && user.getAge() >= value;
				},
				AS	: function accountStatus() {
					if(!Array.isArray(value)) {
						value = [ value ];
					}

					const userAccountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
					return value.map(n => parseInt(n, 10)).includes(userAccountStatus);
				},
				EC	: function isEncoding() {
					const encoding = client.term.outputEncoding.toLowerCase();
					switch(value) {
						case 0	: return 'cp437' === encoding;
						case 1	: return 'utf-8' === encoding;
						default	: return false;
					}
				},
				GM	: function isOneOfGroups() {
					if(!Array.isArray(value)) {
						return false;
					}

					return value.some(groupName => user.isGroupMember(groupName));
				},
				NN	: function isNode() {
					if(!Array.isArray(value)) {
						value = [ value ];
					}
					return value.map(n => parseInt(n, 10)).includes(client.node);
				},
				NP	: function numberOfPosts() {
					const postCount = user.getPropertyAsNumber(UserProps.PostCount) || 0;
					return !isNaN(value) && postCount >= value;
				},
				NC	: function numberOfCalls() {
					const loginCount = user.getPropertyAsNumber(UserProps.LoginCount);
					return !isNaN(value) && loginCount >= value;
				},
				AA	: function accountAge() {
					const accountCreated = moment(user.getProperty(UserProps.AccountCreated));
					const now = moment();
					const daysOld = accountCreated.diff(moment(), 'days');
					return !isNaN(value) &&
						accountCreated.isValid() && 
						now.isAfter(accountCreated) && 
						daysOld >= value;
				},
				BU	: function bytesUploaded() {
					const bytesUp = user.getPropertyAsNumber(UserProps.FileUlTotalBytes) || 0;
					return !isNaN(value) && bytesUp >= value;
				},
				UP	: function uploads() {
					const uls = user.getPropertyAsNumber(UserProps.FileUlTotalCount) || 0;
					return !isNaN(value) && uls >= value;
				},
				BD	: function bytesDownloaded() {
					const bytesDown = user.getPropertyAsNumber(UserProps.FileDlTotalBytes) || 0;
					return !isNaN(value) && bytesDown >= value;
				},
				DL	: function downloads() {
					const dls = user.getPropertyAsNumber(UserProps.FileDlTotalCount) || 0;
					return !isNaN(value) && dls >= value;
				},
				NR	: function uploadDownloadRatioGreaterThan() {
					const ulCount = user.getPropertyAsNumber(UserProps.FileUlTotalCount) || 0;
					const dlCount = user.getPropertyAsNumber(UserProps.FileDlTotalCount) || 0;
					const ratio = ~~((ulCount / dlCount) * 100);
					return !isNaN(value) && ratio >= value;
				},
				KR	: function uploadDownloadByteRatioGreaterThan() {
					const ulBytes = user.getPropertyAsNumber(UserProps.FileUlTotalBytes) || 0;
					const dlBytes = user.getPropertyAsNumber(UserProps.FileDlTotalBytes) || 0;
					const ratio = ~~((ulBytes / dlBytes) * 100);
					return !isNaN(value) && ratio >= value;
				},
				PC	: function postCallRatio() {					
					const postCount		= user.getPropertyAsNumber(UserProps.PostCount) || 0;
					const loginCount	= user.getPropertyAsNumber(UserProps.LoginCount) || 0;
					const ratio = ~~((postCount / loginCount) * 100);
					return !isNaN(value) && ratio >= value;
				},
				SC 	: function isSecureConnection() {
					return client.session.isSecure;
				},
				ML	: function minutesLeft() {
					//	:TODO: implement me!
					return false;
				},
				TH	: function termHeight() {
					return !isNaN(value) && client.term.termHeight >= value;
				},
				TM	: function isOneOfThemes() {
					if(!Array.isArray(value)) {
						return false;
					}

					return value.includes(client.currentTheme.name);
				},
				TT	: function isOneOfTermTypes() {
					if(!Array.isArray(value)) {
						return false;
					}

					return value.includes(client.term.termType);
				},
				TW	: function termWidth() {
					return !isNaN(value) && client.term.termWidth >= value;
				},
				ID	: function isUserId(value) {
					if(!Array.isArray(value)) {
						value = [ value ];
					}

					return value.map(n => parseInt(n, 10)).includes(user.userId);
				},
				WD	: function isOneOfDayOfWeek() {
					if(!Array.isArray(value)) {
						value = [ value ];
					}

					return value.map(n => parseInt(n, 10)).includes(new Date().getDay());
				},
				MM	: function isMinutesPastMidnight() {
					const now = moment();
					const midnight = now.clone().startOf('day')
					const minutesPastMidnight = now.diff(midnight, 'minutes');
					return !isNaN(value) && minutesPastMidnight >= value;
				}
			}[acsCode](value);
		} catch (e) {
			client.log.warn( { acsCode : acsCode, value : value }, 'Invalid ACS string!');
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
	= acs:acsCode a:arg { return checkAccess(acs, a); }

acsCode
	= c:([A-Z][A-Z]) { return c.join(''); }

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

 
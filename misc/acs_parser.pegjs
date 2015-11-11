
{
	var user = options.user;
	var client	= options.client;

	function checkAcs(name, value) {
		return {
			SC 	: function secureConnection() {
				return client.session.isSecure;
			},
			ID	: function userId(value) {
				return user.userId === value;
			}
		}[name](value) || false;
	}

  function check(name, value) {
    // Dummy implementation: returns true when the name starts with 'A'
    return name.charAt(0) == 'A';
  }
}

start
 = expr

expr
 = or_expr

or_expr
 = left:and_expr '|' right:expr { return left || right; }
 / and_expr

and_expr
 = left:not_expr '&'? right:expr { return left && right; }
 / not_expr

not_expr
 = '!' value:atom { return !value; }
 / atom

atom
 = acs_check
 / '(' value:expr ')' { return value; }

comma = ','
ws = ' '

optionalSpc = ws*

acs_check
 = n:name a:arg { return checkAcs(n, a); }

name
 = c:([A-Z][A-Z]) { return c.join(''); }

argNum
 = c:[A-Za-z]+ { return c.join('') }

argVar
 = a:[A-Za-z0-9\-]+ { return a.join('') }

commaList
 = start:(v:argVar comma { return v; })* last:argVar { return start.concat(last); }

allList
 = '{' l:commaList '}' { return l; }

anyList
 = '[' l:commaList ']' { return l; }

arg
 = allList
 / anyList
 / c:[A-Za-z]+ { return c.join(''); }
 / d:[0-9]* { return d ? parseInt(d.join(''), 10) : null; }
 
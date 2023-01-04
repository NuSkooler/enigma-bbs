const { WellKnownLocations } = require('./servers/content/web');
const User = require('./user');
const { Errors } = require('./enig_error');
const UserProps = require('./user_property');

exports.makeUserUrl = makeUserUrl;
exports.webFingerProfileUrl = webFingerProfileUrl;
exports.selfUrl = selfUrl;
exports.userFromAccount = userFromAccount;

function makeUserUrl(webServer, user, relPrefix) {
    return webServer.buildUrl(
        WellKnownLocations.Internal + `${relPrefix}${user.username}`
    );
}

function webFingerProfileUrl(webServer, user) {
    return webServer.buildUrl(WellKnownLocations.Internal + `/wf/@${user.username}`);
}

function selfUrl(webServer, user) {
    return makeUserUrl(webServer, user, '/ap/users/');
}

function userFromAccount(accountName, cb) {
    User.getUserIdAndName(accountName, (err, userId) => {
        if (err) {
            return cb(err);
        }

        User.getUser(userId, (err, user) => {
            if (err) {
                return cb(err);
            }

            const accountStatus = user.getPropertyAsNumber(UserProps.AccountStatus);
            if (
                User.AccountStatus.disabled == accountStatus ||
                User.AccountStatus.inactive == accountStatus
            ) {
                return cb(Errors.AccessDenied('Account disabled', ErrorReasons.Disabled));
            }

            return cb(null, user);
        });
    });
}

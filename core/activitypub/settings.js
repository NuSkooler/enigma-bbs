const UserProps = require('../user_property');
const Config = require('../config').get;

module.exports = class ActivityPubSettings {
    constructor(obj) {
        this.enabled = true;
        this.manuallyApproveFollowers = false;
        this.hideSocialGraph = false; // followers, following
        this.showRealName = true;
        this.image = '';
        this.icon = '';

        //  override default with any op config
        Object.assign(this, Config().users.activityPub);

        //  finally override with any explicit values given to us
        if (obj) {
            Object.assign(this, obj);
        }
    }

    static fromUser(user) {
        if (!user.activityPubSettings) {
            const settingsProp = user.getProperty(UserProps.ActivityPubSettings);
            let settings;
            try {
                const parsed = JSON.parse(settingsProp);
                settings = new ActivityPubSettings(parsed);
            } catch (e) {
                settings = new ActivityPubSettings();
            }

            user.activityPubSettings = settings;
        }

        return user.activityPubSettings;
    }

    persistToUserProperties(user, cb = null) {
        return user.persistProperty(
            UserProps.ActivityPubSettings,
            JSON.stringify(this),
            err => {
                if (!err) {
                    //  drop from cache
                    delete user.activityPubSettings;
                }
                if (cb) {
                    return cb(err);
                }
            }
        );
    }
};

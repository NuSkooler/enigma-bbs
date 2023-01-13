const UserProps = require('./user_property');

module.exports = class ActivityPubSettings {
    constructor(obj) {
        this.enabled = true; //  :TODO: fetch from +op config default
        this.manuallyApproveFollowers = false;
        this.hideSocialGraph = false; // followers, following
        this.showRealName = false;
        this.imageUrl = '';
        this.iconUrl = '';

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
            cb
        );
    }
};

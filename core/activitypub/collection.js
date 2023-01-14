const { ActivityStreamsContext, makeUserUrl } = require('./util');
const { FollowerEntryStatus, getFollowerEntries } = require('./db');

module.exports = class Collection {
    constructor(obj) {
        this['@context'] = ActivityStreamsContext;
        Object.assign(this, obj);
    }

    static followers(owningUser, page, webServer, cb) {
        if (!page) {
            const followersUrl =
                makeUserUrl(webServer, owningUser, '/ap/users/') + '/followers';

            const obj = {
                id: followersUrl,
                type: 'OrderedCollection',
                first: `${followersUrl}?page=1`,
                totalItems: 1,
            };

            return cb(null, new Collection(obj));
        }

        //  :TODO: actually support paging...
        page = parseInt(page);
        const getOpts = {
            status: FollowerEntryStatus.Accepted,
        };
        getFollowerEntries(owningUser, getOpts, (err, followers) => {
            if (err) {
                return cb(err);
            }

            const baseId = makeUserUrl(webServer, owningUser, '/ap/users') + '/followers';

            const obj = {
                id: `${baseId}/page=${page}`,
                type: 'OrderedCollectionPage',
                totalItems: followers.length,
                orderedItems: followers,
                partOf: baseId,
            };

            return cb(null, new Collection(obj));
        });
    }
};

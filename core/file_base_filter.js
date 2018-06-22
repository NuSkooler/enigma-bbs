/* jslint node: true */
'use strict';

//	deps
const _						= require('lodash');
const uuidV4				= require('uuid/v4');

module.exports = class FileBaseFilters {
    constructor(client) {
        this.client	= client;

        this.load();
    }

    static get OrderByValues() {
        return [ 'descending', 'ascending' ];
    }

    static get SortByValues() {
        return [
            'upload_timestamp',
            'upload_by_username',
            'dl_count',
            'user_rating',
            'est_release_year',
            'byte_size',
            'file_name',
        ];
    }

    toArray() {
        return _.map(this.filters, (filter, uuid) => {
            return Object.assign( { uuid : uuid }, filter );
        });
    }

    get(filterUuid) {
        return this.filters[filterUuid];
    }

    add(filterInfo) {
        const filterUuid = uuidV4();

        filterInfo.tags = this.cleanTags(filterInfo.tags);

        this.filters[filterUuid] = filterInfo;

        return filterUuid;
    }

    replace(filterUuid, filterInfo) {
        const filter = this.get(filterUuid);
        if(!filter) {
            return false;
        }

        filterInfo.tags = this.cleanTags(filterInfo.tags);
        this.filters[filterUuid] = filterInfo;
        return true;
    }

    remove(filterUuid) {
        delete this.filters[filterUuid];
    }

    load() {
        let filtersProperty = this.client.user.properties.file_base_filters;
        let defaulted;
        if(!filtersProperty) {
            filtersProperty = JSON.stringify(FileBaseFilters.getBuiltInSystemFilters());
            defaulted = true;
        }

        try {
            this.filters = JSON.parse(filtersProperty);
        } catch(e) {
            this.filters = FileBaseFilters.getBuiltInSystemFilters();	//	something bad happened; reset everything back to defaults :(
            defaulted = true;
            this.client.log.error( { error : e.message, property : filtersProperty }, 'Failed parsing file base filters property' );
        }

        if(defaulted) {
            this.persist( err => {
                if(!err) {
                    const defaultActiveUuid = this.toArray()[0].uuid;
                    this.setActive(defaultActiveUuid);
                }
            });
        }
    }

    persist(cb) {
        return this.client.user.persistProperty('file_base_filters', JSON.stringify(this.filters), cb);
    }

    cleanTags(tags) {
        return tags.toLowerCase().replace(/,?\s+|,/g, ' ').trim();
    }

    setActive(filterUuid) {
        const activeFilter = this.get(filterUuid);

        if(activeFilter) {
            this.activeFilter = activeFilter;
            this.client.user.persistProperty('file_base_filter_active_uuid', filterUuid);
            return true;
        }

        return false;
    }

    static getBuiltInSystemFilters() {
        const U_LATEST	= '7458b09d-40ab-4f9b-a0d7-0cf866646329';

        const filters = {
            [ U_LATEST ] : {
                name	: 'By Date Added',
                areaTag	: '',	//	all
                terms	: '',	//	*
                tags	: '',	//	*
                order	: 'descending',
                sort	: 'upload_timestamp',
                uuid	: U_LATEST,
                system	: true,
            }
        };

        return filters;
    }

    static getActiveFilter(client) {
        return new FileBaseFilters(client).get(client.user.properties.file_base_filter_active_uuid);
    }

    static getFileBaseLastViewedFileIdByUser(user) {
        return parseInt((user.properties.user_file_base_last_viewed || 0));
    }

    static setFileBaseLastViewedFileIdForUser(user, fileId, allowOlder, cb) {
        if(!cb && _.isFunction(allowOlder)) {
            cb = allowOlder;
            allowOlder = false;
        }

        const current = FileBaseFilters.getFileBaseLastViewedFileIdByUser(user);
        if(!allowOlder && fileId < current) {
            if(cb) {
                cb(null);
            }
            return;
        }

        return user.persistProperty('user_file_base_last_viewed', fileId, cb);
    }
};

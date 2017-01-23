/* jslint node: true */
'use strict';

const _			= require('lodash');
const uuids		= require('node-uuid');

module.exports = class FileBaseFilters {
	constructor(client) {
		this.client	= client;
		
		this.load();
	}

	static get OrderByValues() {
		return [ 'ascending', 'descending' ];
	}

	static get SortByValues() {
		return [
			'upload_timestamp',
			'upload_by_username',
			'dl_count',
			'user_rating',
			'est_release_year',
			'byte_size',
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
		const filterUuid = uuids.v4();
		
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
			filtersProperty = JSON.stringify(FileBaseFilters.getDefaultFilters());
			defaulted = true;
		}

		try {
			this.filters = JSON.parse(filtersProperty);
		} catch(e) {
			this.filters = FileBaseFilters.getDefaultFilters();	//	something bad happened; reset everything back to defaults :(
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
		return tags.toLowerCase().replace(/,?\s+|\,/g, ' ').trim();
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

	static getDefaultFilters() {
		const filters = {};
		
		const uuid = uuids.v4();
		filters[uuid] = {
			name	: 'Default',
			areaTag	: '',	//	all
			terms	: '',	//	*
			tags	: '',	//	*
			order	: 'ascending',
			sort	: 'upload_timestamp',
			uuid	: uuid,
		};

		return filters;
	}

	static getActiveFilter(client) {
		return new FileBaseFilters(client).get(client.user.properties.file_base_filter_active_uuid);
	}
};

/* jslint node: true */
'use strict';

//	ENiGMA½
const PluginModule			= require('./plugin_module.js').PluginModule;
const Config				= require('./config.js').config;
const Log					= require('./logger.js').log;

const _						= require('lodash');
const later					= require('later');
const path					= require('path');

exports.getModule				= EventSchedulerModule;
exports.EventSchedulerModule	= EventSchedulerModule;	//	allow for loadAndStart

exports.moduleInfo = {
	name	: 'Event Scheduler',
	desc	: 'Support for scheduling arbritary events',
	author	: 'NuSkooler',
};

const SCHEDULE_REGEXP	= /(?:^|or )?(@watch\:)([^\0]+)?$/;
const ACTION_REGEXP		= /\@(method|execute)\:([^\0]+)?$/;

class ScheduledEvent {
	constructor(events, name) {
		this.name		= name;
		this.schedule 	= this.parseScheduleString(events[name].schedule);
		this.action		= this.parseActionSpec(events[name].action);
		if(this.action) {
			this.action.args = events[name].args;
		}	
	}
	
	get isValid() {
		if((!this.schedule || (!this.schedule.sched && !this.schedule.watchFile)) || !this.action) {
			return false;
		}
		
		if('method' === this.action.type && !this.action.location) {
			return false;
		}
		
		return true; 	
	}
		
	parseScheduleString(schedStr) {
		if(!schedStr) {
			return false;
		}
		
		let schedule = {};
		
		const m = SCHEDULE_REGEXP.exec(schedStr);
		if(m) {
			schedStr = schedStr.substr(0, m.index).trim();
			
			if('@watch:' === m[1]) {
				schedule.watchFile = m[2];
			}
		}

		if(schedStr.length > 0) {
			const sched = later.parse.text(schedStr);
			if(-1 === sched.error) {
				schedule.sched = sched;
			}	
		}
		
		//	return undefined if we couldn't parse out anything useful
		if(!_.isEmpty(schedule)) {
			return schedule;
		}
	}
	
	parseActionSpec(actionSpec) {
		if(actionSpec) {
			if('@' === actionSpec[0]) {
				const m = ACTION_REGEXP.exec(actionSpec);
				if(m) {
					if(m[2].indexOf(':') > -1) {
						const parts = m[2].split(':');
						return {
							type		: m[1],							
							location	: parts[0],
							what		: parts[1],
						};
					} else {
						return {
							type	: m[1],
							what	: m[2],
						};
					}
				}
			} else {
				return { 
					type	: 'execute',
					what	: actionSpec,
				};
			}			
		}	
	}
}

function EventSchedulerModule(options) {
	PluginModule.call(this, options);
	
	if(_.has(Config, 'eventScheduler')) {
		this.moduleConfig = Config.eventScheduler;
	}
	
	const self = this;
	this.runningActions = new Set();
	
	this.performAction = function(schedEvent) {
		if(self.runningActions.has(schedEvent.name)) {
			return;	//	already running
		} 
		
		self.runningActions.add(schedEvent.name);
		
		if('method' === schedEvent.action.type) {
			const modulePath = path.join(__dirname, '../', schedEvent.action.location);	//	enigma-bbs base + supplied location (path/file.js')
			try {
				const methodModule = require(modulePath);
				methodModule[schedEvent.action.what](schedEvent.action.args, err => {
					if(err) {
						Log.debug(
							{ error : err.toString(), eventName : schedEvent.name, action : schedEvent.action },
							'Error while performing scheduled event action');
					}
					
					self.runningActions.delete(schedEvent.name);	
				});
			} catch(e) {
				Log.warn(
					{ error : e.toString(), eventName : schedEvent.name, action : schedEvent.action },
					'Failed to perform scheduled event action');
				
				self.runningActions.delete(schedEvent.name);
			}
		}
	};
}

//	convienence static method for direct load + start
EventSchedulerModule.loadAndStart = function(cb) {
	const loadModuleEx = require('./module_util.js').loadModuleEx;
			
	const loadOpts = {
		name		: path.basename(__filename, '.js'),
		path		: __dirname,
	};
	
	loadModuleEx(loadOpts, (err, mod) => {
		if(err) {
			return cb(err);
		}
		
		const modInst = new mod.getModule();
		modInst.startup( err => {
			return cb(err);
		});		
	});
};

EventSchedulerModule.prototype.startup = function(cb) {
	
	this.eventTimers = [];
	const self = this;
	
	if(this.moduleConfig && _.has(this.moduleConfig, 'events')) {
		const events = Object.keys(this.moduleConfig.events).map( name => {
			return new ScheduledEvent(this.moduleConfig.events, name);
		});
		
		events.forEach( schedEvent => {
			if(!schedEvent.isValid) {
				Log.warn( { eventName : schedEvent.name }, 'Invalid scheduled event entry');
				return;
			}
			
			if(schedEvent.schedule.sched) {			
				this.eventTimers.push(later.setInterval( () => {
					self.performAction(schedEvent);	
				}, schedEvent.schedule.sched));
			}
			
			//	:TODO: handle watchfile -> performAction
		});
	}
	
	cb(null);
};

EventSchedulerModule.prototype.shutdown = function(cb) {
	if(this.eventTimers) {
		this.eventTimers.forEach( et => et.clear() );
	}
	
	cb(null);
};

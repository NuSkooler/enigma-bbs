/* jslint node: true */
'use strict';

//  ENiGMA½
const { MenuModule } = require('./menu_module.js');
const UserPreference = require('./user_preference.js');
const { Errors } = require('./enig_error.js');

//  deps
const async = require('async');
const _ = require('lodash');

/*
    Let a user pick between alternatives the operator offers, such as which
    message reader the new scan opens. The choice is stored as a pref__<name>
    user property that menus route on with PV[pref__<name>,<value>]; see
    website/src/content/docs/modules/user-pref-select.md.

    Configuration (menu config only; never from user input):
        pref                  the user property, e.g. pref__msg_reader
        choices               [ { value, text, desc, acs } ]
        defaultText           text of the "(board default)" entry, which
                              clears the preference
        defaultDesc           its description
        currentIndicator      marks the current choice (default "*")
        notCurrentIndicator   marks the others (default " ")

    Choices whose acs the caller does not pass are not shown. A choice whose
    value PV could not test, and a pref outside pref__, are refused at load.

    Item fields (VM1 / TV1 itemFormat, focusItemFormat or TV columns, and the
    TL10+ custom range):
        text              currentIndicator + " " + name (the default display)
        name              the choice's text without the indicator
        desc              the choice's description
        value             the value stored; empty for the board default
        currentIndicator  currentIndicator or notCurrentIndicator
        isCurrent         true for the current choice
        isDefault         true for the "(board default)" entry
    The TL10+ custom range also gets:
        currentName       name of the current choice
        currentValue      value of the current choice; empty for the default
        pref              the preference name
*/

exports.moduleInfo = {
    name: 'User Preference Select',
    desc: 'Lets a user choose between alternatives the operator offers',
    author: 'NuSkooler',
};

const MciViewIds = {
    choiceList: 1, //  VM1 / TV1
    desc: 2, //  TL2 - description of the focused choice
    customRangeStart: 10, //  TL10+ updated on focus change
};

const Defaults = {
    defaultText: '(board default)',
    defaultDesc: 'Use the default this board has chosen',
    currentIndicator: '*',
    notCurrentIndicator: ' ',
};

exports.getModule = class UserPrefSelectModule extends MenuModule {
    constructor(options) {
        super(options);

        this.menuMethods = {
            select: (formData, extraArgs, cb) => {
                return this._selectFocused(cb);
            },
            done: (formData, extraArgs, cb) => {
                return this.prevMenu(cb);
            },
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            async.series(
                [
                    next => this.prepViewController('main', 0, mciData.menu, next),
                    next => this._initChoiceList(next),
                ],
                err => {
                    if (err) {
                        this.client.log.error(
                            { error: err.message },
                            'Failed loading user preference select'
                        );
                    }
                    return cb(err);
                }
            );
        });
    }

    _config() {
        return this.menuConfig.config || {};
    }

    //
    //  Validate the menu's pref and choices once, keeping the choices this
    //  caller may see. Bad choices are skipped with a single warning.
    //
    _loadChoices() {
        const config = this._config();

        if (!UserPreference.isValidPrefName(config.pref)) {
            return Errors.Invalid(
                `Invalid or missing "pref" "${config.pref}": must start with "${UserPreference.PrefPrefix}" and match [A-Za-z0-9\\-_+]`
            );
        }

        this.pref = config.pref;

        const rejected = [];
        const choices = Array.isArray(config.choices) ? config.choices : [];
        this.choices = [];

        choices.forEach(choice => {
            const value = _.isPlainObject(choice)
                ? UserPreference.normalizePrefValue(choice.value)
                : undefined;
            if (!_.isString(value)) {
                //  undefined (cannot be tested by PV) or null (would clear)
                rejected.push(_.isPlainObject(choice) ? choice.value : choice);
                return;
            }

            if (_.isString(choice.acs) && !this._passesAcs(choice.acs)) {
                return;
            }

            this.choices.push({
                value,
                name: _.isString(choice.text) ? choice.text : value,
                desc: _.isString(choice.desc) ? choice.desc : '',
            });
        });

        if (rejected.length > 0) {
            this.client.log.warn(
                { pref: this.pref, rejected },
                'Skipping user preference choices with invalid values (must match [A-Za-z0-9\\-_+])'
            );
        }

        return null;
    }

    _passesAcs(acs) {
        return this.client.acs.check({ acs }, 'acs');
    }

    _indicators() {
        const config = this._config();
        return {
            current: _.isString(config.currentIndicator)
                ? config.currentIndicator
                : Defaults.currentIndicator,
            notCurrent: _.isString(config.notCurrentIndicator)
                ? config.notCurrentIndicator
                : Defaults.notCurrentIndicator,
        };
    }

    //  key of the item that matches the user's stored preference
    _currentKey() {
        const stored = this.client.user.getProperty(this.pref);
        const index = this.choices.findIndex(c => c.value === stored);
        //  an unset (or no longer offered) preference shows the board default
        return -1 === index ? 0 : index + 1;
    }

    //
    //  Items for the list: the board default first (key 0), then each
    //  choice (key = its position + 1). |key| identifies the row on a
    //  TableView, which may sort rows and copies them.
    //
    _buildItems() {
        const config = this._config();
        const { current, notCurrent } = this._indicators();
        const currentKey = this._currentKey();

        const entries = [
            {
                value: '',
                name: _.isString(config.defaultText)
                    ? config.defaultText
                    : Defaults.defaultText,
                desc: _.isString(config.defaultDesc)
                    ? config.defaultDesc
                    : Defaults.defaultDesc,
                isDefault: true,
            },
            ...this.choices.map(c => Object.assign({ isDefault: false }, c)),
        ];

        this.items = entries.map((entry, key) => {
            const isCurrent = key === currentKey;
            const currentIndicator = isCurrent ? current : notCurrent;
            return Object.assign(entry, {
                key,
                isCurrent,
                currentIndicator,
                text: `${currentIndicator} ${entry.name}`,
            });
        });

        return this.items;
    }

    _choiceListView() {
        return this.viewControllers.main.getView(MciViewIds.choiceList);
    }

    //  screen index of the row with |key|; a TableView may have sorted them
    _indexOfKey(view, key) {
        if (_.isFunction(view.findIndex)) {
            return Math.max(
                view.findIndex(item => item.key === key),
                0
            );
        }
        return key;
    }

    _focusedItem(view) {
        const row = _.isFunction(view.getFocusedItem)
            ? view.getFocusedItem()
            : view.items[view.focusedItemIndex];
        return row ? this.items.find(item => item.key === row.key) : undefined;
    }

    _initChoiceList(cb) {
        const view = this._choiceListView();
        if (!view) {
            return cb(
                Errors.MissingMci(`Missing choice list MCI ${MciViewIds.choiceList}`)
            );
        }

        const err = this._loadChoices();
        if (err) {
            return cb(err);
        }

        view.on('index update', () => this._onFocusChange(view));

        //  start on the current choice
        view.setItems(this._buildItems());
        view.setFocusItemIndex(this._indexOfKey(view, this._currentKey()));
        view.redraw();
        this._onFocusChange(view);
        return cb(null);
    }

    _selectFocused(cb) {
        const view = this._choiceListView();
        const item = view && this._focusedItem(view);
        if (!item) {
            return cb(null);
        }

        //  the board default clears the preference
        const value = item.isDefault ? null : item.value;
        UserPreference.setUserPreference(this.client.user, this.pref, value, err => {
            if (err) {
                this.client.log.warn(
                    { error: err.message, pref: this.pref, value },
                    'Failed setting user preference'
                );
                return cb(null);
            }

            this.client.log.debug({ pref: this.pref, value }, 'User preference set');

            view.setItems(this._buildItems(), { keepFocus: true });
            view.setFocusItemIndex(this._indexOfKey(view, item.key));
            view.redraw();
            this._onFocusChange(view);
            return cb(null);
        });
    }

    _onFocusChange(view) {
        const item = this._focusedItem(view);
        if (!item) {
            return;
        }

        this.setViewText('main', MciViewIds.desc, item.desc);

        const current = this.items.find(i => i.isCurrent) || this.items[0];
        this.updateCustomViewTextsWithFilter(
            'main',
            MciViewIds.customRangeStart,
            Object.assign({}, item, {
                currentName: current.name,
                currentValue: current.value,
                pref: this.pref,
            })
        );
    }
};

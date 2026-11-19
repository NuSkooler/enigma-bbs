'use strict';

//  ENiGMA½
const { MenuView } = require('./menu_view.js');
const ansi = require('./ansi_term.js');
const strUtil = require('./string_util.js');
const formatString = require('./string_format');
const { pipeToAnsi } = require('./color_codes.js');
const PipeCodes = require('./pipe_codes.js');

//  deps
const _ = require('lodash');
const moment = require('moment');

//  Rows are drawn already rendered: only ANSI escapes are codes.
const ANSI_ONLY = { dialect: 'ansi' };

// eslint-disable-next-line no-control-regex
const LEADING_SGR = /^(?:\x1b\[[0-9;]*m)*/;

//
//  TableView (%TV): a selection list with columns, group rows, unselectable
//  rows, an optional header and sorting. See
//  website/src/content/docs/art/views/table_view.md for the full reference.
//
//  Configuration comes in three layers, lowest first:
//    view built-ins < module defaults (setDefaults()) < menu/theme mci
//  The object-valued properties below deep-merge across the layers (and,
//  in theme.js, between menu and theme mci for TV entries); every other
//  property replaces.
//
const DeepMergeProperties = ['columns', 'stateSGR', 'sort', 'group', 'sortIndicator'];

//  Properties held in TableView's layered configuration
const ConfigProperties = [
    ...DeepMergeProperties,
    'columnOrder',
    'header',
    'headerSGR',
    'headerFormat',
    'separator',
    'focusSGR',
    'focusColumns',
    'altRowSGR',
    'emptyText',
    'sortable',
    'itemFormat',
    'focusItemFormat',
    'plainFields',
];

const BuiltInDefaults = {
    header: false,
    separator: '',
    emptyText: '',
    sortIndicator: { asc: '▲', desc: '▼' }, //  CP437 0x1E / 0x1F
};

const DefaultBoolText = ['Yes', 'No'];

//  merge customizer: arrays (columnOrder, rules, sort.then...) replace
const replaceArrays = (objVal, srcVal) => (Array.isArray(srcVal) ? srcVal : undefined);

function isEmptyValue(v) {
    return undefined === v || null === v || '' === v;
}

function isDateLike(v) {
    return v instanceof Date || moment.isMoment(v);
}

function inferType(v) {
    if (_.isNumber(v)) {
        return 'number';
    }
    if (_.isBoolean(v)) {
        return 'bool';
    }
    if (isDateLike(v)) {
        return 'date';
    }
    return 'text';
}

//  Dates come as moments, Dates, epoch milliseconds or ISO 8601 strings;
//  anything else is not a date (and never reaches moment's lenient parser)
function toMoment(v) {
    if (moment.isMoment(v)) {
        return v;
    }
    if (v instanceof Date || _.isNumber(v)) {
        return moment(v);
    }
    if (_.isString(v)) {
        return moment(v, moment.ISO_8601, true);
    }
    return moment.invalid();
}

function isNumeric(v) {
    if (_.isNumber(v)) {
        return !isNaN(v);
    }
    return _.isString(v) && '' !== v.trim() && !isNaN(Number(v));
}

//  Does |v| read as |type|?
function conformsTo(v, type) {
    switch (type) {
        case 'number':
            return isNumeric(v);
        case 'date':
            return toMoment(v).isValid();
        case 'bool':
            return _.isBoolean(v);
        default:
            return true;
    }
}

//
//  Sorting ranks values by class first so mixed values still sort in one
//  consistent order: in a typed column, values that read as its type come
//  before those that do not (compared as text); untyped, numbers come
//  before dates, booleans and text. Returns [rank, type to compare by].
//
const SortClassOrder = ['number', 'date', 'bool', 'text'];

function sortClass(v, type) {
    if (type) {
        return conformsTo(v, type) ? [0, type] : [1, 'text'];
    }
    const t = inferType(v);
    return [SortClassOrder.indexOf(t), t];
}

//  User-supplied text: tab, CR and LF become spaces; other C0 controls, DEL
//  and C1 controls (U+009B is a CSI on some terminals) are dropped, so an
//  escape sequence cannot reach the terminal or upset width maths; pipes are
//  shown as typed
// eslint-disable-next-line no-control-regex
const LINE_CONTROLS = /[\t\r\n]/g;
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

function plainText(s) {
    return PipeCodes.escape(
        String(s).replace(LINE_CONTROLS, ' ').replace(OTHER_CONTROLS, '')
    );
}

function compareValues(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareTyped(a, b, type) {
    switch (type) {
        case 'number': {
            const na = Number(a);
            const nb = Number(b);
            if (!isNaN(na) && !isNaN(nb)) {
                return compareValues(na, nb); //  not na - nb: Infinity - Infinity is NaN
            }
            break;
        }

        case 'date': {
            const ma = toMoment(a);
            const mb = toMoment(b);
            if (ma.isValid() && mb.isValid()) {
                return compareValues(ma.valueOf(), mb.valueOf());
            }
            break;
        }

        case 'bool':
            return (a ? 1 : 0) - (b ? 1 : 0);
    }

    return String(a).localeCompare(String(b), undefined, {
        sensitivity: 'base',
        numeric: true,
    });
}

function normalizeOrder(order) {
    return 'desc' === String(order || '').toLowerCase() ? 'desc' : 'asc';
}

function normalizeSortKey(k) {
    if (_.isString(k) && k) {
        return { column: k, order: 'asc' };
    }
    if (_.isPlainObject(k) && _.isString(k.column) && k.column) {
        return { column: k.column, order: normalizeOrder(k.order) };
    }
    return null;
}

//  'sort' in config: true (VM style: by text), 'field', or { column, order, then }
function normalizeSortSpec(sort) {
    if (true === sort) {
        return { column: 'text', order: 'asc', then: [] };
    }
    if (_.isString(sort) && sort) {
        return { column: sort, order: 'asc', then: [] };
    }
    if (!_.isPlainObject(sort) || !_.isString(sort.column) || !sort.column) {
        return null;
    }
    const then = (Array.isArray(sort.then) ? sort.then : [sort.then])
        .map(normalizeSortKey)
        .filter(k => k && k.column !== sort.column);
    return { column: sort.column, order: normalizeOrder(sort.order), then };
}

class TableView extends MenuView {
    constructor(options) {
        options = Object.assign({}, options);
        options.cursor = options.cursor || 'hide';
        options.justify = options.justify || 'left';

        //  MenuView's constructor would set these before our state exists
        const initialItems = options.items;
        delete options.items;

        super(options);

        this.focusItemAtTop = _.isBoolean(options.focusItemAtTop)
            ? options.focusItemAtTop
            : false;

        this._explicit = {};
        this._moduleDefaults = {};
        this._explicitKeys = new Set();
        this._moduleItems = [];
        this._headerData = {};
        this._runtimeSort = undefined; //  undefined: follow config; null: module order
        this._top = 0;
        this._rowScreen = new Map();
        this._drawn = false;
        this._layoutDirty = true;

        ConfigProperties.forEach(name => {
            if (options[name] !== undefined) {
                this._explicit[name] = options[name];
            }
        });

        //  a table defaults to the rest of the row
        this.initDefaultWidth(this.client.term.termWidth);

        if (!_.isObject(options.specialKeyMap)) {
            Object.assign(this.specialKeyMap, {
                'page up': ['page up'],
                'page down': ['page down'],
            });
        }

        this._applyConfig();

        if (initialItems) {
            this.setItems(initialItems);
        }
    }

    //  ── Configuration ────────────────────────────────────────────────────────

    //
    //  A module's in-code defaults: they sit beneath menu and theme mci, so an
    //  operator's value always wins. TableView properties layer (and deep-merge
    //  where noted above); any other view property is applied only when the
    //  menu or theme has not set it. Does not redraw.
    //
    setDefaults(defaults) {
        if (!_.isPlainObject(defaults)) {
            return this;
        }

        Object.keys(defaults).forEach(name => {
            const value = defaults[name];
            if (ConfigProperties.includes(name)) {
                if (
                    DeepMergeProperties.includes(name) &&
                    _.isPlainObject(value) &&
                    _.isPlainObject(this._moduleDefaults[name])
                ) {
                    this._moduleDefaults[name] = _.mergeWith(
                        {},
                        this._moduleDefaults[name],
                        value,
                        replaceArrays
                    );
                } else {
                    this._moduleDefaults[name] = value;
                }
            } else if (!this._explicitKeys.has(name)) {
                this._settingDefault = true;
                try {
                    this.setPropertyValue(name, value);
                } finally {
                    this._settingDefault = false;
                }
            }
        });

        this._applyConfig();
        return this;
    }

    //  The effective configuration: built-ins < module defaults < explicit
    getConfig() {
        const out = {};
        [BuiltInDefaults, this._moduleDefaults, this._explicit].forEach(layer => {
            Object.keys(layer).forEach(name => {
                const value = layer[name];
                if (undefined === value) {
                    return;
                }
                if (
                    DeepMergeProperties.includes(name) &&
                    _.isPlainObject(value) &&
                    _.isPlainObject(out[name])
                ) {
                    out[name] = _.mergeWith({}, out[name], value, replaceArrays);
                } else {
                    out[name] = _.isPlainObject(value)
                        ? _.mergeWith({}, value, replaceArrays)
                        : value;
                }
            });
        });
        return out;
    }

    _pipe(s) {
        if (isEmptyValue(s)) {
            return '';
        }
        return pipeToAnsi(String(s), this.client);
    }

    //  A fill spec may carry its own colour: '|08─'. Returns { sgr, ch }.
    _parseFill(spec, fallback = ' ') {
        if (_.isNumber(spec)) {
            spec = String.fromCharCode(spec);
        }
        if (!_.isString(spec) || !spec) {
            return { sgr: '', ch: fallback };
        }
        const rendered = this._pipe(spec);
        //  leading SGRs are the fill's colour; the first character is the fill
        const sgr = rendered.match(LEADING_SGR)[0];
        const ch = strUtil.renderFirstChar(rendered.slice(sgr.length));
        return { sgr, ch: ch || fallback };
    }

    _applyConfig() {
        const cfg = (this._cfg = this.getConfig());

        this._separator = this._pipe(cfg.separator);
        this._separatorWidth = strUtil.renderStringLength(this._separator, ANSI_ONLY);
        this._focusSGRValue = _.isString(cfg.focusSGR) ? this._pipe(cfg.focusSGR) : null;
        this._headerSGR = this._pipe(cfg.headerSGR);
        this._altRowSGR = this._pipe(cfg.altRowSGR);
        this._focusColumns = Array.isArray(cfg.focusColumns) ? cfg.focusColumns : null;
        this._plainFields = new Set(
            Array.isArray(cfg.plainFields) ? cfg.plainFields : []
        );

        this._stateSGR = {};
        if (_.isPlainObject(cfg.stateSGR)) {
            Object.keys(cfg.stateSGR).forEach(state => {
                this._stateSGR[state] = this._pipe(cfg.stateSGR[state]);
            });
        }

        const group = _.isPlainObject(cfg.group) ? cfg.group : {};
        this._group = {
            format: _.isString(group.format) ? group.format : '{text}',
            fill: this._parseFill(group.fillChar),
            justify: group.justify || 'left',
            sgr: this._pipe(group.sgr),
        };

        const indicator = _.isPlainObject(cfg.sortIndicator) ? cfg.sortIndicator : {};
        this._sortIndicator = {
            asc: this._pipe(indicator.asc),
            desc: this._pipe(indicator.desc),
        };

        //  every configured column; _visibleColumns() drops hidden ones
        const columns = _.isPlainObject(cfg.columns) ? cfg.columns : {};
        this._columnDefs = {};
        Object.keys(columns).forEach(id => {
            if (_.isPlainObject(columns[id])) {
                this._columnDefs[id] = this._makeColumn(id, columns[id]);
            }
        });
        this._columnOrder = Array.isArray(cfg.columnOrder)
            ? cfg.columnOrder
            : Object.keys(this._columnDefs);

        this._inferredTypes = {};
        this._layoutDirty = true;
        this.invalidateRenderCache();

        if (this._moduleItems.length) {
            this._resort();
        }
    }

    _makeColumn(id, def) {
        let padding = [0, 0];
        if (_.isNumber(def.padding)) {
            padding = [def.padding, def.padding];
        } else if (Array.isArray(def.padding)) {
            padding = [parseInt(def.padding[0]) || 0, parseInt(def.padding[1]) || 0];
        }

        return {
            id,
            field: _.isString(def.field) && def.field ? def.field : id,
            label: _.isString(def.label) ? def.label : '',
            type: ['text', 'number', 'date', 'bool'].includes(def.type)
                ? def.type
                : undefined,
            width: def.width,
            justify: def.justify,
            textOverflow: _.isString(def.textOverflow) ? def.textOverflow : undefined,
            fill: this._parseFill(def.fillChar),
            padding: padding.map(p => Math.max(0, p)),
            format: _.isString(def.format) ? def.format : undefined,
            dateFormat: _.isString(def.dateFormat) ? def.dateFormat : undefined,
            nullText: _.isString(def.nullText) ? def.nullText : '',
            boolText: [0, 1].map(i =>
                Array.isArray(def.boolText) && !isEmptyValue(def.boolText[i])
                    ? String(def.boolText[i])
                    : DefaultBoolText[i]
            ),
            sgr: this._pipe(def.sgr),
            focusSGR: this._pipe(def.focusSGR),
            pipeCodes: _.isBoolean(def.pipeCodes) ? def.pipeCodes : undefined,
            minTermWidth: parseInt(def.minTermWidth) || 0,
            sortOrder: def.sortOrder ? normalizeOrder(def.sortOrder) : 'asc',
        };
    }

    hasColumns() {
        return this._columnOrder.some(id => this._columnDefs[id]);
    }

    //  Columns in display order, without those hidden by minTermWidth
    _visibleColumns() {
        const termWidth = this.client.term.termWidth;
        return this._columnOrder
            .map(id => this._columnDefs[id])
            .filter(col => col && !(col.minTermWidth > termWidth));
    }

    //  Column widths: fixed and percentage first, then 'fill' (or no width)
    //  columns share what is left. Percentages are of the view width less
    //  the separators.
    _layoutColumns() {
        const cols = this._visibleColumns();
        const avail = Math.max(
            0,
            this.dimens.width - this._separatorWidth * Math.max(0, cols.length - 1)
        );

        const fills = [];
        let used = 0;
        cols.forEach(col => {
            const w = col.width;
            if (_.isNumber(w) || (_.isString(w) && /^\s*\d+\s*$/.test(w))) {
                col._width = Math.max(0, parseInt(w));
            } else if (_.isString(w) && /^\s*\d+(\.\d+)?\s*%\s*$/.test(w)) {
                col._width = Math.floor((avail * parseFloat(w)) / 100);
            } else {
                col._width = 0;
                fills.push(col);
            }
            used += col._width;
        });

        //  fixed and percentage widths that do not fit shrink in proportion
        //  (the columns left over go to the first ones); fill columns get 0
        if (used > avail) {
            const sized = cols.filter(col => !fills.includes(col));
            let total = 0;
            sized.forEach(col => {
                col._width = Math.floor((col._width * avail) / used);
                total += col._width;
            });
            for (let i = 0; total < avail && sized.length; i = (i + 1) % sized.length) {
                sized[i]._width += 1;
                total += 1;
            }
            used = total;
        }

        let remain = Math.max(0, avail - used);
        fills.forEach((col, i) => {
            const share = Math.floor(remain / (fills.length - i));
            col._width = share;
            remain -= share;
        });

        this._layoutCols = cols;
    }

    _columnType(col) {
        if (col.type) {
            return col.type;
        }
        if (!(col.id in this._inferredTypes)) {
            const sample = this.items.find(
                item => this._isItemRow(item) && !isEmptyValue(_.get(item, col.field))
            );
            this._inferredTypes[col.id] = sample
                ? inferType(_.get(sample, col.field))
                : 'text';
        }
        return this._inferredTypes[col.id];
    }

    _headerLines() {
        if (true !== this._cfg.header) {
            return 0;
        }
        return _.isString(this._cfg.headerFormat) || this.hasColumns() ? 1 : 0;
    }

    _bodyHeight() {
        return Math.max(0, this.dimens.height - this._headerLines());
    }

    _updateLayout() {
        if (!this._layoutDirty) {
            return;
        }
        this._layoutDirty = false;

        if (this.autoAdjustHeight) {
            let lines = this._headerLines();
            if (this.hasItemRows()) {
                for (let i = 0; i < this.items.length; ++i) {
                    lines += this._rowHeight(i);
                }
            } else {
                lines += 1; //  emptyText
            }
            this.dimens.height = Math.max(
                1,
                Math.min(lines, this.client.term.termHeight - this.position.row + 1)
            );
        }

        this._layoutColumns();
    }

    setPropertyValue(propName, value) {
        if (!this._settingDefault) {
            this._explicitKeys.add(propName);
        }

        if (ConfigProperties.includes(propName)) {
            this._explicit[propName] = value;
            this._applyConfig();
            return;
        }

        switch (propName) {
            case 'focusItemAtTop':
                if (_.isBoolean(value)) {
                    this.focusItemAtTop = value;
                }
                return;

            case 'focusItems': //  not supported by TableView
                return;

            case 'focusItemIndex':
                this.focusedItemIndex = this._snapToSelectable(parseInt(value) || 0);
                this.invalidateRenderCache();
                return;

            case 'height':
            case 'width':
                this._layoutDirty = true;
                this.invalidateRenderCache();
                break;
        }

        super.setPropertyValue(propName, value);
    }

    //  The module's plain fields: a module default, so an operator's
    //  plainFields (menu / theme) wins; a column's pipeCodes overrides both
    setPlainFields(fields) {
        this._moduleDefaults.plainFields = fields;
        this._applyConfig();
    }

    setHeaderData(data) {
        this._headerData = _.isPlainObject(data) ? data : {};
        if (this._drawn && this._headerLines()) {
            this._drawHeader();
        }
    }

    //  ── Items ────────────────────────────────────────────────────────────────

    _isItemRow(item) {
        return item && 'group' !== item.kind;
    }

    isSelectable(index) {
        const item = this.items[index];
        if (!item) {
            return false;
        }
        return _.isBoolean(item.selectable) ? item.selectable : 'group' !== item.kind;
    }

    hasSelectable() {
        return this.items.some((item, i) => this.isSelectable(i));
    }

    //  Rows other than group rows, selectable or not: a table that has none
    //  shows emptyText
    hasItemRows() {
        return this.items.some(item => this._isItemRow(item));
    }

    _itemKey(item) {
        if (!item) {
            return undefined;
        }
        if (!isEmptyValue(item.key)) {
            return item.key;
        }
        return isEmptyValue(item.data) ? undefined : item.data;
    }

    _keyIndex(key) {
        if (isEmptyValue(key)) {
            return -1;
        }
        return this.items.findIndex(item => this._itemKey(item) === key);
    }

    _firstSelectable(from = 0) {
        for (let i = Math.max(0, from); i < this.items.length; ++i) {
            if (this.isSelectable(i)) {
                return i;
            }
        }
        return -1;
    }

    _lastSelectable(from = this.items.length - 1) {
        for (let i = Math.min(from, this.items.length - 1); i >= 0; --i) {
            if (this.isSelectable(i)) {
                return i;
            }
        }
        return -1;
    }

    //  |index| (clamped) if selectable, else the nearest selectable row (the
    //  next one on a tie); 0 when there is none
    _snapToSelectable(index) {
        index = Math.min(Math.max(index, 0), Math.max(this.items.length - 1, 0));
        if (this.isSelectable(index)) {
            return index;
        }
        for (let d = 1; d < this.items.length; ++d) {
            if (this.isSelectable(index + d)) {
                return index + d;
            }
            if (this.isSelectable(index - d)) {
                return index - d;
            }
        }
        return 0;
    }

    //
    //  Rows are strings or objects. Objects keep their raw typed fields;
    //  TableView reads:
    //    kind       - 'item' (default) or 'group'
    //    selectable - defaults to kind !== 'group'
    //    state      - picks a colour from stateSGR
    //    key        - stable ID for keepFocus / updateItem (falls back to data)
    //    data       - value returned by getData()
    //    text       - default field for column-less mode
    //
    //  options.keepFocus: refocus the same row by key, else the clamped index.
    //  Does not redraw.
    //
    setItems(items, options = {}) {
        if (!Array.isArray(items)) {
            return;
        }

        const prevKey = this._itemKey(this.items[this.focusedItemIndex]);
        const prevIndex = this.focusedItemIndex;

        this.complexItems = false;
        this._moduleItems = items.map(item => {
            if (_.isString(item)) {
                return { text: item };
            }
            if (_.isObject(item)) {
                this.complexItems = true;
                return Object.assign({}, item);
            }
            return { text: isEmptyValue(item) ? '' : String(item) };
        });

        this._inferredTypes = {};
        this._applySort();

        let focus = -1;
        if (options.keepFocus) {
            //  the same row by key; if that row (or a group taking its key)
            //  cannot be selected now, the nearest one that can
            const keyIndex = this._keyIndex(prevKey);
            focus = this._snapToSelectable(-1 === keyIndex ? prevIndex : keyIndex);
        } else {
            this._top = 0;
        }
        if (-1 === focus) {
            focus = this._snapToSelectable(0);
        }
        this.focusedItemIndex = focus;

        this._layoutDirty = true;
        this.invalidateRenderCache();
        this._ensureVisible(this.focusedItemIndex);
    }

    getItems() {
        return this.complexItems ? this.items : this.items.map(item => item.text);
    }

    findIndex(pred) {
        if (!_.isFunction(pred)) {
            return -1;
        }
        return this.items.findIndex((item, i) => pred(item, i));
    }

    getFocusedItem() {
        return this.isSelectable(this.focusedItemIndex)
            ? this.items[this.focusedItemIndex]
            : null;
    }

    //
    //  Merge |patch| into the row with this key (falling back to data;
    //  numbers are keys too) and redraw that row only; focus and scroll stay
    //  where they are. The row is not re-sorted (call setSort() to re-apply
    //  the sort). Returns false if no such row. See updateItemAt().
    //
    updateItem(key, patch) {
        return this._updateItemAt(this._keyIndex(key), patch);
    }

    //  updateItem() by index (screen order, after sorting)
    updateItemAt(index, patch) {
        return this._updateItemAt(
            Number.isInteger(index) && this.items[index] ? index : -1,
            patch
        );
    }

    _updateItemAt(index, patch) {
        if (-1 === index || !_.isPlainObject(patch)) {
            return false;
        }

        const item = this.items[index];
        const wasSelectable = this.isSelectable(index);
        const hadSelectable = this.hasSelectable();
        const hadItemRows = this.hasItemRows();
        const prevKind = item.kind;

        Object.assign(item, patch);
        this.removeRenderCacheItem(index);

        const kindChanged = (prevKind || 'item') !== (item.kind || 'item');
        if (
            kindChanged ||
            'selectable' in patch ||
            wasSelectable !== this.isSelectable(index) ||
            hadSelectable !== this.hasSelectable() ||
            hadItemRows !== this.hasItemRows()
        ) {
            //  group runs (sorting, stripes), focus or emptiness may change
            if (kindChanged) {
                this._resort();
            }
            this._computeAltRows();
            this.focusedItemIndex = this._snapToSelectable(this.focusedItemIndex);
            this.invalidateRenderCache();
            this._layoutDirty = true;
            this._ensureVisible(this.focusedItemIndex);
            if (this._drawn) {
                this.redraw();
            }
            return true;
        }

        if (this._drawn) {
            this.drawItem(index);
        }
        return true;
    }

    removeItem(index) {
        const item = this.items[index];
        if (!item) {
            return;
        }
        this.items.splice(index, 1);
        const moduleIndex = this._moduleItems.indexOf(item);
        if (moduleIndex > -1) {
            this._moduleItems.splice(moduleIndex, 1);
        }
        if (this.focusedItemIndex > index) {
            this.focusedItemIndex -= 1;
        }
        this.focusedItemIndex = this._snapToSelectable(this.focusedItemIndex);
        this._computeAltRows();
        this.invalidateRenderCache();
        this._layoutDirty = true;
        this._ensureVisible(this.focusedItemIndex);
    }

    //  'index update' carries the row as a second argument
    emitIndexUpdate() {
        if (!this.isSelectable(this.focusedItemIndex)) {
            return; //  nothing selectable: no index update (VM parity)
        }
        this.emit('index update', this.focusedItemIndex, this.getFocusedItem());
    }

    //  data whenever set (numbers included), else the index; null when no
    //  row is selectable
    getData() {
        const item = this.getFocusedItem();
        if (!item) {
            return null;
        }
        return isEmptyValue(item.data) ? this.focusedItemIndex : item.data;
    }

    //  hot keys that point at an unselectable row are ignored
    getHotKeyItemIndex(ch) {
        const index = super.getHotKeyItemIndex(ch);
        return index >= 0 && this.isSelectable(index) ? index : -1;
    }

    //  ── Sorting ──────────────────────────────────────────────────────────────

    getSort() {
        if (undefined !== this._runtimeSort) {
            return this._runtimeSort ? _.cloneDeep(this._runtimeSort) : null;
        }
        return normalizeSortSpec(this._cfg.sort);
    }

    _sortColumn(id) {
        return this._columnDefs[id] || { id, field: id, type: undefined };
    }

    //  this.items = module order, sorted within groups when a sort is set
    _applySort() {
        const spec = this.getSort();
        const items = this._moduleItems.slice();

        if (spec) {
            const keys = [{ column: spec.column, order: spec.order }, ...spec.then].map(
                k => ({ col: this._sortColumn(k.column), desc: 'desc' === k.order })
            );

            const compare = (a, b) => {
                for (const { col, desc } of keys) {
                    const va = _.get(a, col.field);
                    const vb = _.get(b, col.field);
                    const ea = isEmptyValue(va);
                    const eb = isEmptyValue(vb);
                    if (ea || eb) {
                        if (ea && eb) {
                            continue;
                        }
                        return ea ? 1 : -1; //  empty values last, either order
                    }
                    const [ra, type] = sortClass(va, col.type);
                    const [rb] = sortClass(vb, col.type);
                    if (ra !== rb) {
                        return ra - rb; //  by class, in either order
                    }
                    const c = compareTyped(va, vb, type);
                    if (0 !== c) {
                        return desc ? -c : c;
                    }
                }
                return 0;
            };

            //  group rows stay in place; each run between them sorts on its own
            const sortRun = (start, end) => {
                if (end - start > 1) {
                    const run = items.slice(start, end).sort(compare);
                    items.splice(start, run.length, ...run);
                }
            };

            let start = 0;
            items.forEach((item, i) => {
                if ('group' === item.kind) {
                    sortRun(start, i);
                    start = i + 1;
                }
            });
            sortRun(start, items.length);
        }

        this.items = items;
        this._computeAltRows();
    }

    //  zebra striping restarts after each group row
    _computeAltRows() {
        this._altRows = [];
        let n = 0;
        this.items.forEach((item, i) => {
            if ('group' === item.kind) {
                n = 0;
                this._altRows[i] = false;
            } else {
                this._altRows[i] = 1 === n % 2;
                n += 1;
            }
        });
    }

    //  Re-sort, keeping focus on the same row
    _resort() {
        const focused = this.items[this.focusedItemIndex];
        const prevIndex = this.focusedItemIndex;

        this._applySort();
        this.invalidateRenderCache();

        const index = focused ? this.items.indexOf(focused) : -1;
        this.focusedItemIndex = -1 === index ? this._snapToSelectable(prevIndex) : index;

        this._ensureVisible(this.focusedItemIndex);
        return prevIndex !== this.focusedItemIndex;
    }

    _afterSortChange() {
        const moved = this._resort();
        if (this._drawn) {
            this.redraw();
        }
        if (moved) {
            this.emitIndexUpdate();
        }
        return this.getSort();
    }

    //  setSort(column, order); setSort(null) returns to module order.
    //  The config's sort.then tie-breakers are kept.
    setSort(column, order) {
        if (isEmptyValue(column)) {
            this._runtimeSort = null;
        } else {
            const configured = normalizeSortSpec(this._cfg.sort);
            this._runtimeSort = {
                column: String(column),
                order: order
                    ? normalizeOrder(order)
                    : this._sortColumn(column).sortOrder || 'asc',
                then: configured
                    ? configured.then.filter(k => k.column !== String(column))
                    : [],
            };
        }
        return this._afterSortChange();
    }

    //  Next column in 'sortable' (default: every visible column), wrapping
    //  Columns hidden by minTermWidth (or left out of columnOrder) are
    //  skipped even when listed in sortable.
    cycleSort() {
        const visible = new Set(this._visibleColumns().map(col => col.id));
        const sortable = (
            Array.isArray(this._cfg.sortable) ? this._cfg.sortable : [...visible]
        ).filter(id => visible.has(id) || !this._columnDefs[id]);
        if (!sortable.length) {
            return this.getSort();
        }
        const current = this.getSort();
        const at = current ? sortable.indexOf(current.column) : -1;
        const next = sortable[(at + 1) % sortable.length];
        return this.setSort(next);
    }

    toggleSortOrder() {
        const current = this.getSort();
        if (!current) {
            return null;
        }
        current.order = 'asc' === current.order ? 'desc' : 'asc';
        this._runtimeSort = current;
        return this._afterSortChange();
    }

    //  ── Navigation ───────────────────────────────────────────────────────────

    _rowHeight(index) {
        //  one line per row; PR 2 (wrap) makes this variable
        return this.items[index] ? 1 : 0;
    }

    _linesBetween(from, to) {
        let lines = 0;
        for (let i = from; i <= to; ++i) {
            lines += this._rowHeight(i);
        }
        return lines;
    }

    _fits(from, to) {
        return this._linesBetween(from, to) <= this._bodyHeight();
    }

    //  The first index of the window whose last whole row is |index|
    _topFor(index) {
        const body = this._bodyHeight();
        let top = index;
        let lines = this._rowHeight(index);
        while (top > 0 && lines + this._rowHeight(top - 1) <= body) {
            top -= 1;
            lines += this._rowHeight(top);
        }
        return top;
    }

    //  The last index drawn whole from |top|
    _bottomFrom(top) {
        const body = this._bodyHeight();
        let lines = 0;
        let i = top;
        for (; i < this.items.length; ++i) {
            lines += this._rowHeight(i);
            if (lines > body) {
                break;
            }
        }
        return Math.max(top, i - 1);
    }

    //
    //  Move the window as little as possible to show |index| whole, pulling
    //  the unselectable rows directly above it (its group header) into view
    //  when it lands at the top, and using any space left at the end.
    //
    _ensureVisible(index) {
        this._updateLayout();

        if (!this.items.length || this._bodyHeight() < 1) {
            this._top = 0;
            return;
        }

        //  read-only: no focus to show; keep the window where it is
        if (!this.hasSelectable()) {
            return this._clampWindow();
        }

        index = Math.min(Math.max(index, 0), this.items.length - 1);
        let top = Math.min(Math.max(this._top, 0), this.items.length - 1);

        if (this.focusItemAtTop) {
            top = index;
        } else if (index < top) {
            top = index;
        } else if (index > this._bottomFrom(top)) {
            top = this._topFor(index);
        }

        if (top === index) {
            while (top > 0 && !this.isSelectable(top - 1) && this._fits(top - 1, index)) {
                top -= 1;
            }
        }

        //  past the last selectable row: show trailing rows if they fit
        if (index === this._lastSelectable()) {
            const tailTop = this._topFor(this.items.length - 1);
            if (tailTop > top && tailTop <= index) {
                top = tailTop;
            }
        }

        //  no blank space below the last row while rows above are hidden
        const last = this.items.length - 1;
        if (this._bottomFrom(top) === last) {
            while (top > 0 && this._fits(top - 1, last)) {
                top -= 1;
            }
        }

        this._top = top;
    }

    //  Keep the window in range without a row to show (a read-only table)
    _clampWindow() {
        this._updateLayout();
        const last = this.items.length - 1;
        let top = Math.min(Math.max(this._top, 0), Math.max(last, 0));
        if (last >= 0 && this._bottomFrom(top) === last) {
            while (top > 0 && this._fits(top - 1, last)) {
                top -= 1;
            }
        }
        this._top = top;
    }

    //  With nothing selectable the cursor keys scroll the window
    _scrollTo(top) {
        if (!this.hasItemRows()) {
            return;
        }
        const prevTop = this._top;
        this._top = top;
        this._clampWindow();
        if (!this._drawn || prevTop !== this._top) {
            this.redraw();
        }
    }

    _moveFocus(index) {
        const prev = this.focusedItemIndex;
        const prevTop = this._top;

        this.focusedItemIndex = index;
        this._ensureVisible(index);

        if (!this._drawn || prevTop !== this._top || !this._rowScreen.has(index)) {
            return this.redraw();
        }

        if (prev !== index) {
            this.drawItem(prev);
        }
        this.drawItem(index);
    }

    setFocusItemIndex(index) {
        if (!this.hasSelectable()) {
            this.focusedItemIndex = 0;
            return;
        }
        this._moveFocus(this._snapToSelectable(index));
    }

    _focusAndEmit(index) {
        if (-1 === index) {
            return;
        }
        this._moveFocus(index);
        this.emitIndexUpdate();
    }

    //  Up/down wrap at the ends of the list (VerticalMenuView parity)
    focusNext() {
        if (!this.hasSelectable()) {
            return this._scrollTo(this._top + 1);
        }
        let next = this._firstSelectable(this.focusedItemIndex + 1);
        if (-1 === next) {
            next = this._firstSelectable(0);
        }
        this._focusAndEmit(next);
    }

    focusPrevious() {
        if (!this.hasSelectable()) {
            return this._scrollTo(this._top - 1);
        }
        let prev = this._lastSelectable(this.focusedItemIndex - 1);
        if (-1 === prev) {
            prev = this._lastSelectable();
        }
        this._focusAndEmit(prev);
    }

    _pageRows(from, dir) {
        //  rows covered by one screen of lines from |from| in |dir|
        const body = Math.max(1, this._bodyHeight());
        let lines = 0;
        let i = from;
        while (true) {
            const next = i + dir;
            if (!this.items[next]) {
                break;
            }
            lines += this._rowHeight(next);
            if (lines > body) {
                break;
            }
            i = next;
        }
        return i;
    }

    //  Page down; at the last selectable row it wraps to the top (VM parity)
    focusNextPageItem() {
        if (!this.hasSelectable()) {
            return this._scrollTo(this._top + Math.max(1, this._bodyHeight()));
        }
        if (this.focusedItemIndex >= this._lastSelectable()) {
            return this.focusNext();
        }
        const candidate = this._pageRows(this.focusedItemIndex, 1);
        let target = this._firstSelectable(candidate);
        if (-1 === target) {
            target = this._lastSelectable();
        }
        this._focusAndEmit(target);
    }

    focusPreviousPageItem() {
        if (!this.hasSelectable()) {
            return this._scrollTo(this._top - Math.max(1, this._bodyHeight()));
        }
        if (this.focusedItemIndex <= this._firstSelectable()) {
            return this.focusPrevious();
        }
        const candidate = this._pageRows(this.focusedItemIndex, -1);
        let target = this._lastSelectable(candidate);
        if (-1 === target) {
            target = this._firstSelectable();
        }
        this._focusAndEmit(target);
    }

    focusFirst() {
        if (!this.hasSelectable()) {
            return this._scrollTo(0);
        }
        this._focusAndEmit(this._firstSelectable());
    }

    focusLast() {
        if (!this.hasSelectable()) {
            return this._scrollTo(this.items.length - 1);
        }
        this._focusAndEmit(this._lastSelectable());
    }

    //
    //  Focus the next selectable row after the focused one for which
    //  pred(item, index) is true. options.wrap (default true) continues from
    //  the top. Returns the new index, or -1 (focus unchanged).
    //
    focusNextMatching(pred, options = {}) {
        return this._focusMatching(pred, options, 1);
    }

    focusPreviousMatching(pred, options = {}) {
        return this._focusMatching(pred, options, -1);
    }

    _focusMatching(pred, options, dir) {
        if (!_.isFunction(pred) || !this.items.length) {
            return -1;
        }
        const wrap = false !== options.wrap;
        const count = this.items.length;
        const start = this.focusedItemIndex;
        for (let step = 1; step <= count; ++step) {
            let i = start + dir * step;
            if (i < 0 || i >= count) {
                if (!wrap) {
                    break;
                }
                i = (i + count) % count;
            }
            if (i === start && !wrap) {
                break;
            }
            if (this.isSelectable(i) && pred(this.items[i], i)) {
                if (i !== start) {
                    this._focusAndEmit(i);
                }
                return i;
            }
        }
        return -1;
    }

    onKeyPress(ch, key) {
        if (key) {
            if (this.isKeyMapped('up', key.name)) {
                this.focusPrevious();
            } else if (this.isKeyMapped('down', key.name)) {
                this.focusNext();
            } else if (this.isKeyMapped('page up', key.name)) {
                this.focusPreviousPageItem();
            } else if (this.isKeyMapped('page down', key.name)) {
                this.focusNextPageItem();
            } else if (this.isKeyMapped('home', key.name)) {
                this.focusFirst();
            } else if (this.isKeyMapped('end', key.name)) {
                this.focusLast();
            }
        }

        super.onKeyPress(ch, key);
    }

    //  ── Rendering ────────────────────────────────────────────────────────────

    _viewFocusSGR() {
        return null !== this._focusSGRValue ? this._focusSGRValue : this.getFocusSGR();
    }

    //  The base colour of a row (|col| null: separators and trailing fill)
    //  Is |col| (null: separators and trailing fill) lit on the focused row?
    _lit(col) {
        return col
            ? !this._focusColumns || this._focusColumns.includes(col.id)
            : !this._focusColumns;
    }

    _rowBaseSGR(index, focused, col) {
        if (focused && this._lit(col)) {
            return this._viewFocusSGR();
        }
        const alt = this._altRowSGR && this._altRows && this._altRows[index];
        return this.getSGR() + (alt ? this._altRowSGR : '');
    }

    _stateSGRFor(item) {
        return (item && !isEmptyValue(item.state) && this._stateSGR[item.state]) || '';
    }

    //  Hook for conditional cell rules (PR 2): highest colour precedence
    _cellRuleSGR(/* col, item, value */) {
        return '';
    }

    //
    //  A cell's colour, lowest precedence first so each layer only overrides
    //  the attributes it sets:
    //    view default (lightbar on the focused row) < column sgr < row
    //    stateSGR < column focusSGR (focused row) < cell rule
    //
    _cellSGR(col, item, index, focused, value) {
        return (
            this._rowBaseSGR(index, focused, col) +
            col.sgr +
            this._stateSGRFor(item) +
            (focused && this._lit(col) ? col.focusSGR : '') +
            this._cellRuleSGR(col, item, value)
        );
    }

    //
    //  The fields a format sees. 'default': the plainFields paths (dotted
    //  paths too) as plain text; 'all': every string, at any depth; 'none':
    //  as they are. Only what is changed is copied.
    //
    _formatFields(item, mode = 'default') {
        if ('none' === mode || ('default' === mode && !this._plainFields.size)) {
            return item;
        }

        if ('all' === mode) {
            return _.cloneDeepWith(item, v => {
                if (_.isString(v)) {
                    return plainText(v);
                }
                return _.isPlainObject(v) || Array.isArray(v) ? undefined : v;
            });
        }

        const out = Object.assign({}, item);
        this._plainFields.forEach(path => {
            path = String(path);
            //  a flat key that contains a dot wins, as it does for _.get()
            if (Object.prototype.hasOwnProperty.call(item, path)) {
                if (_.isString(item[path])) {
                    out[path] = plainText(item[path]);
                }
                return;
            }
            const parts = path.split('.');
            const last = parts.pop();
            let src = item;
            let dst = out;
            for (const k of parts) {
                if (!_.isObject(src[k])) {
                    return;
                }
                if (dst[k] === src[k]) {
                    dst[k] = Array.isArray(src[k])
                        ? src[k].slice()
                        : Object.assign({}, src[k]);
                }
                src = src[k];
                dst = dst[k];
            }
            if (_.isString(src[last])) {
                dst[last] = plainText(src[last]);
            }
        });
        return out;
    }

    _format(fmt, obj) {
        return this._pipe(formatString(fmt, obj, { client: this.client }));
    }

    _dateFormat(col) {
        if (col.dateFormat) {
            return col.dateFormat;
        }
        const helpers = _.get(this.client, 'currentTheme.helpers');
        return helpers && _.isFunction(helpers.getDateFormat)
            ? helpers.getDateFormat('short')
            : 'MM/DD/YYYY';
    }

    //  What a cell shows, rendered (ANSI)
    _cellText(col, item) {
        const raw = _.get(item, col.field);
        if (isEmptyValue(raw)) {
            return this._pipe(col.nullText);
        }

        const mode =
            true === col.pipeCodes ? 'none' : false === col.pipeCodes ? 'all' : 'default';
        const plain =
            'all' === mode || ('default' === mode && this._plainFields.has(col.field));

        let value = raw;
        switch (this._columnType(col)) {
            case 'date': {
                const m = toMoment(raw);
                value = m.isValid() ? m.format(this._dateFormat(col)) : String(raw);
                break;
            }

            case 'bool':
                value = String(raw ? col.boolText[0] : col.boolText[1]);
                break;

            case 'number':
                if (
                    !_.isNumber(raw) &&
                    !isNaN(Number(raw)) &&
                    '' !== String(raw).trim()
                ) {
                    value = Number(raw);
                }
                break;
        }

        if (!_.isNumber(value)) {
            value = String(value);
            if (plain) {
                value = plainText(value);
            }
        }

        if (col.format) {
            return this._format(
                col.format,
                Object.assign({}, this._formatFields(item, mode), { value })
            );
        }

        return this._pipe(String(value));
    }

    _fit(text, width, omission) {
        if (width <= 0) {
            return '';
        }
        if (strUtil.renderStringLength(text, ANSI_ONLY) <= width) {
            return text;
        }
        //  a marker wider than the cell is cut to it, never into the next one
        let marker = _.isString(omission) ? omission : '';
        if (strUtil.renderStringLength(marker, ANSI_ONLY) > width) {
            marker = strUtil.renderSubstr(marker, 0, width, ANSI_ONLY);
        }
        return strUtil.renderTruncate(text, {
            length: width,
            omission: marker,
            dialect: 'ansi',
        });
    }

    _justifyFor(col) {
        if (col.justify) {
            return col.justify;
        }
        return 'number' === this._columnType(col) ? 'right' : 'left';
    }

    //
    //  |text| (rendered) justified in |width| columns of |fill| inside a cell
    //  drawn in |sgr|, then the cell's padding. The cell colour is put back
    //  only where the text or a coloured fill changed it.
    //
    _padCell(col, text, sgr, justify) {
        const [padL, padR] = col.padding;
        const left = Math.min(padL, col._width);
        const right = Math.max(0, Math.min(padR, col._width - left));
        const width = Math.max(0, col._width - left - right);

        text = this._fit(text, width, col.textOverflow);

        const fill = col.fill;
        const padLen = Math.max(0, width - strUtil.renderStringLength(text, ANSI_ONLY));

        let out = `${sgr}${' '.repeat(left)}`;
        let dirty = false; //  the colour in effect is no longer |sgr|
        const restore = () => {
            if (dirty) {
                out += sgr;
                dirty = false;
            }
        };
        const emitFill = n => {
            if (n > 0) {
                if (fill.sgr) {
                    out += sgr + fill.sgr;
                    dirty = true;
                } else {
                    restore();
                }
                out += fill.ch.repeat(n);
            }
        };
        const emitText = () => {
            restore();
            out += text;
            dirty = text.includes('\x1b');
        };

        if ('right' === justify || 'R' === justify) {
            emitFill(padLen);
            emitText();
        } else if (['center', 'C', 'both'].includes(justify)) {
            const r = Math.ceil(padLen / 2);
            emitFill(padLen - r);
            emitText();
            emitFill(r);
        } else {
            emitText();
            emitFill(padLen);
        }

        if (right) {
            restore();
            out += ' '.repeat(right);
        }
        return out;
    }

    _renderCell(col, item, index, focused) {
        const sgr = this._cellSGR(col, item, index, focused, _.get(item, col.field));
        const omission = _.isString(col.textOverflow)
            ? col.textOverflow
            : this.textOverflow;
        return this._padCell(
            Object.assign({}, col, { textOverflow: omission }),
            this._cellText(col, item),
            sgr,
            this._justifyFor(col)
        );
    }

    //  Pad / cut a rendered line to exactly the view width
    _finishLine(line, fillSGR) {
        const width = this.dimens.width;
        const len = strUtil.renderStringLength(line, ANSI_ONLY);
        if (len < width) {
            line += `${fillSGR}${this.fillChar.repeat(width - len)}`;
        } else if (len > width) {
            line = line.slice(0, strUtil.renderSplitPos(line, width, false));
        }
        return this.clipToTerminalWidth(`${line}${this.getSGR()}`);
    }

    _renderColumnsRow(item, index, focused) {
        const cols = this._layoutCols || [];
        const sep = `${this._rowBaseSGR(index, focused, null)}${this._separator}`;
        const line = cols
            .map(col => this._renderCell(col, item, index, focused))
            .join(this._separatorWidth || this._separator ? sep : '');
        return this._finishLine(line, this._rowBaseSGR(index, focused, null));
    }

    _renderGroupRow(item) {
        const sgr = this.getSGR() + this._group.sgr + this._stateSGRFor(item);
        const text = this._fit(
            this._format(this._group.format, this._formatFields(item)),
            this.dimens.width,
            this.textOverflow
        );
        const line = strUtil.pad(
            text,
            this.dimens.width,
            this._group.fill.ch,
            this._group.justify,
            sgr,
            sgr + this._group.fill.sgr,
            ANSI_ONLY
        );
        return this._finishLine(line, sgr);
    }

    //  Column-less mode: itemFormat / focusItemFormat, as VerticalMenuView
    _renderFormatRow(item, index, focused) {
        const cfg = this._cfg;
        const fmt =
            focused && _.isString(cfg.focusItemFormat)
                ? cfg.focusItemFormat
                : _.isString(cfg.itemFormat)
                  ? cfg.itemFormat
                  : '{text}';

        let text = this._format(fmt, this._formatFields(item));
        if (!this.complexItems) {
            text = strUtil.stylizeString(
                text,
                focused ? this.focusTextStyle : this.textStyle
            );
        }

        const base = focused
            ? _.isString(cfg.focusItemFormat)
                ? ''
                : this._viewFocusSGR()
            : this._rowBaseSGR(index, false, null);
        const sgr = base + this._stateSGRFor(item);

        text = this._fit(text, this.dimens.width, this.textOverflow);
        const line = `${sgr}${strUtil.pad(
            `${text}${this.getSGR()}`,
            this.dimens.width,
            this.fillChar,
            this.justify,
            '',
            '',
            ANSI_ONLY
        )}`;
        return this._finishLine(line, this.getSGR());
    }

    _renderRow(index, focused) {
        const item = this.items[index];
        if ('group' === item.kind) {
            return this._renderGroupRow(item);
        }
        return this.hasColumns()
            ? this._renderColumnsRow(item, index, focused)
            : this._renderFormatRow(item, index, focused);
    }

    _renderHeader() {
        const sgr = this.getSGR() + this._headerSGR;

        if (_.isString(this._cfg.headerFormat)) {
            const text = this._fit(
                this._format(
                    this._cfg.headerFormat,
                    this._formatFields(this._headerData)
                ),
                this.dimens.width,
                this.textOverflow
            );
            return this._finishLine(`${sgr}${text}`, sgr);
        }

        const sort = this.getSort();
        const line = (this._layoutCols || [])
            .map(col => {
                const [padL, padR] = col.padding;
                const width = Math.max(0, col._width - padL - padR);
                const indicator =
                    sort && sort.column === col.id ? this._sortIndicator[sort.order] : '';
                const indicatorWidth = strUtil.renderStringLength(indicator, ANSI_ONLY);
                let label = this._pipe(col.label);
                if (indicatorWidth && indicatorWidth <= width) {
                    label = `${this._fit(label, width - indicatorWidth, col.textOverflow)}${
                        label ? sgr : ''
                    }${indicator}`;
                }
                return this._padCell(
                    Object.assign({}, col, { fill: { sgr: '', ch: ' ' } }),
                    label,
                    sgr,
                    this._justifyFor(col)
                );
            })
            .join(`${sgr}${this._separator}`);

        return this._finishLine(line, sgr);
    }

    _drawHeader() {
        this.client.term.write(
            `${ansi.goto(this.position.row, this.position.col)}${this._renderHeader()}`
        );
    }

    drawItem(index) {
        if (!this._rowScreen.has(index) || !this.items[index]) {
            return;
        }

        const focused = index === this.focusedItemIndex && this.isSelectable(index);
        let line = this.getRenderCacheItem(index, focused);
        if (!line) {
            line = this._renderRow(index, focused);
            this.setRenderCacheItem(index, line, focused);
        }

        this.client.term.write(
            `${ansi.goto(this._rowScreen.get(index), this.position.col)}${line}`
        );
    }

    _blankLine(row) {
        this.client.term.write(
            `${ansi.goto(row, this.position.col)}${this.getSGR()}${this.fillChar.repeat(
                this.dimens.width
            )}`
        );
    }

    redraw() {
        super.redraw();

        this._updateLayout();

        //  the footprint shrank (auto height after setItems / removeItem, a
        //  new height or width): blank what was drawn before, as VM does
        const prev = this._drawnDimens;
        if (
            prev &&
            (prev.height > this.dimens.height || prev.width > this.dimens.width)
        ) {
            const blank = ' '.repeat(Math.max(prev.width, this.dimens.width));
            for (let r = 0; r < prev.height; ++r) {
                this.client.term.write(
                    `${ansi.goto(this.position.row + r, this.position.col)}${this.getSGR()}${blank}`
                );
            }
        }
        this._drawnDimens = { width: this.dimens.width, height: this.dimens.height };

        let row = this.position.row;
        const lastRow = this.position.row + this.dimens.height - 1;

        if (this._headerLines()) {
            this._drawHeader();
            row += 1;
        }

        this._rowScreen = new Map();

        if (this.hasItemRows()) {
            this._ensureVisible(this.focusedItemIndex);

            let i = this._top;
            for (; i < this.items.length; ++i) {
                const height = this._rowHeight(i);
                if (row + height - 1 > lastRow) {
                    break;
                }
                this._rowScreen.set(i, row);
                this.drawItem(i);
                row += height;
            }
            this.viewWindow = { top: this._top, bottom: i - 1 };
        } else {
            this.viewWindow = { top: 0, bottom: -1 };
            if (row <= lastRow) {
                this.client.term.write(
                    `${ansi.goto(row, this.position.col)}${this._finishLine(
                        `${this.getSGR()}${this._fit(
                            this._pipe(this._cfg.emptyText),
                            this.dimens.width,
                            this.textOverflow
                        )}`,
                        this.getSGR()
                    )}`
                );
                row += 1;
            }
        }

        for (; row <= lastRow; ++row) {
            this._blankLine(row);
        }

        this._drawn = true;
    }

    setFocus(focused) {
        super.setFocus(focused);
        this.redraw();
    }

    setHeight(height) {
        super.setHeight(height);
        this._layoutDirty = true;
    }

    setWidth(width) {
        super.setWidth(width);
        this._layoutDirty = true;
        this.invalidateRenderCache();
    }

    setPosition(...args) {
        super.setPosition(...args);
        this._layoutDirty = true;
    }

    setTextOverflow(overflow) {
        super.setTextOverflow(overflow);
        this._layoutDirty = true;
    }
}

exports.TableView = TableView;
exports.DeepMergeProperties = DeepMergeProperties;

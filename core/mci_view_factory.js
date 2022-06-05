/* jslint node: true */
'use strict';

//  ENiGMA½
const TextView = require('./text_view.js').TextView;
const View = require('./view.js').View;
const EditTextView = require('./edit_text_view.js').EditTextView;
const ButtonView = require('./button_view.js').ButtonView;
const VerticalMenuView = require('./vertical_menu_view.js').VerticalMenuView;
const HorizontalMenuView = require('./horizontal_menu_view.js').HorizontalMenuView;
const FullMenuView = require('./full_menu_view.js').FullMenuView;
const SpinnerMenuView = require('./spinner_menu_view.js').SpinnerMenuView;
const ToggleMenuView = require('./toggle_menu_view.js').ToggleMenuView;
const MaskEditTextView = require('./mask_edit_text_view.js').MaskEditTextView;
const KeyEntryView = require('./key_entry_view.js');
const MultiLineEditTextView =
    require('./multi_line_edit_text_view.js').MultiLineEditTextView;
const getPredefinedMCIValue = require('./predefined_mci.js').getPredefinedMCIValue;
const ansi = require('./ansi_term.js');

//  deps
const assert = require('assert');
const _ = require('lodash');

exports.MCIViewFactory = MCIViewFactory;

function MCIViewFactory(client) {
    this.client = client;
}

MCIViewFactory.UserViewCodes = [
    'TL',
    'ET',
    'ME',
    'MT',
    'PL',
    'BT',
    'VM',
    'HM',
    'FM',
    'SM',
    'TM',
    'KE',

    //
    //  XY is a special MCI code that allows finding positions
    //  and counts for key lookup, but does not explicitly
    //  represent a visible View on it's own
    //
    'XY',
];

MCIViewFactory.MovementCodes = ['CF', 'CB', 'CU', 'CD'];

MCIViewFactory.prototype.createFromMCI = function (mci) {
    assert(mci.code);
    assert(mci.id > 0);
    assert(mci.position);

    var view;
    var options = {
        client: this.client,
        id: mci.id,
        ansiSGR: mci.SGR,
        ansiFocusSGR: mci.focusSGR,
        position: { row: mci.position[0], col: mci.position[1] },
    };

    //  :TODO: These should use setPropertyValue()!
    function setOption(pos, name) {
        if (mci.args.length > pos && mci.args[pos].length > 0) {
            options[name] = mci.args[pos];
        }
    }

    function setWidth(pos) {
        if (mci.args.length > pos && mci.args[pos].length > 0) {
            if (!_.isObject(options.dimens)) {
                options.dimens = {};
            }
            options.dimens.width = parseInt(mci.args[pos], 10);
        }
    }

    function setFocusOption(pos, name) {
        if (
            mci.focusArgs &&
            mci.focusArgs.length > pos &&
            mci.focusArgs[pos].length > 0
        ) {
            options[name] = mci.focusArgs[pos];
        }
    }

    //
    //  Note: Keep this in sync with UserViewCodes above!
    //
    switch (mci.code) {
        //  Text Label (Text View)
        case 'TL':
            setOption(0, 'textStyle');
            setOption(1, 'justify');
            setWidth(2);

            view = new TextView(options);
            break;

        //  Edit Text
        case 'ET':
            setWidth(0);

            setOption(1, 'textStyle');
            setFocusOption(0, 'focusTextStyle');

            view = new EditTextView(options);
            break;

        //  Masked Edit Text
        case 'ME':
            setOption(0, 'textStyle');
            setFocusOption(0, 'focusTextStyle');

            view = new MaskEditTextView(options);
            break;

        //  Multi Line Edit Text
        case 'MT':
            //  :TODO: apply params
            view = new MultiLineEditTextView(options);
            break;

        //  Pre-defined Label (Text View)
        //  :TODO: Currently no real point of PL -- @method replaces this pretty much... probably remove
        case 'PL':
            if (mci.args.length > 0) {
                options.text = getPredefinedMCIValue(this.client, mci.args[0]);
                if (options.text) {
                    setOption(1, 'textStyle');
                    setOption(2, 'justify');
                    setWidth(3);

                    view = new TextView(options);
                }
            }
            break;

        //  Button
        case 'BT':
            if (mci.args.length > 0) {
                options.dimens = { width: parseInt(mci.args[0], 10) };
            }

            setOption(1, 'textStyle');
            setOption(2, 'justify');

            setFocusOption(0, 'focusTextStyle');

            view = new ButtonView(options);
            break;

        //  Vertial Menu
        case 'VM':
            setOption(0, 'itemSpacing');
            setOption(1, 'justify');
            setOption(2, 'textStyle');

            setFocusOption(0, 'focusTextStyle');

            view = new VerticalMenuView(options);
            break;

        //  Horizontal Menu
        case 'HM':
            setOption(0, 'itemSpacing');
            setOption(1, 'textStyle');

            setFocusOption(0, 'focusTextStyle');

            view = new HorizontalMenuView(options);
            break;

        //  Full Menu
        case 'FM':
            setOption(0, 'itemSpacing');
            setOption(1, 'itemHorizSpacing');
            setOption(2, 'justify');
            setOption(3, 'textStyle');

            setFocusOption(0, 'focusTextStyle');

            view = new FullMenuView(options);
            break;

        case 'SM':
            setOption(0, 'textStyle');
            setOption(1, 'justify');

            setFocusOption(0, 'focusTextStyle');

            view = new SpinnerMenuView(options);
            break;

        case 'TM':
            if (mci.args.length > 0) {
                var styleSG1 = { fg: parseInt(mci.args[0], 10) };
                if (mci.args.length > 1) {
                    styleSG1.bg = parseInt(mci.args[1], 10);
                }
                options.styleSG1 = ansi.getSGRFromGraphicRendition(styleSG1, true);
            }

            setFocusOption(0, 'focusTextStyle');

            view = new ToggleMenuView(options);
            break;

        case 'KE':
            view = new KeyEntryView(options);
            break;

        case 'XY':
            view = new View(options);
            break;

        default:
            if (!MCIViewFactory.MovementCodes.includes(mci.code)) {
                options.text = getPredefinedMCIValue(this.client, mci.code);
                if (_.isString(options.text)) {
                    setWidth(0);

                    setOption(1, 'textStyle');
                    setOption(2, 'justify');

                    view = new TextView(options);
                }
            }
            break;
    }

    if (view) {
        view.mciCode = mci.code;
    }

    return view;
};

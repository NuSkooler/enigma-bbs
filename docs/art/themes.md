---
layout: page
title: Themes
---
## Themes
ENiGMA½ comes with an advanced theming system allowing system operators to highly customize the look and feel of their boards. A given installation can have as many themes as you like for your users to choose from.

## General Information
Themes live in `art/themes/`. Each theme (and thus it's *theme ID*) is a directory within the `themes` directory. The theme itself is simply a collection of art files, and a `theme.hjson` file that further defines layout, colors & formatting, etc.

ENiGMA½ comes with a default theme by [Luciano Ayres](http://blocktronics.org/tag/luciano-ayres/) of [Blocktronics](http://blocktronics.org/) called Mystery Skull. This theme is in `art/themes/luciano_blocktronics`, and thus it's *theme ID* is `luciano_blocktronics`.

## Art
For information on art files, see [General Art Information](general.md). In general, to theme a piece of art, create a version of it in your themes directory.

:memo: Remember that by default, the system will allow for randomly selecting art (in one of the directories mentioned above) by numbering it: `FOO1.ANS`, `FOO2.ANS`, etc.!

## Theme Sections
Themes are some important sections to be aware of:

| Config Item | Description                                              |
|-------------|----------------------------------------------------------|
| `info` | This section describes the theme. |
| `customization` | The beef! |

### Info Block
The `info` configuration block describes the theme itself.

| Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `name`   | :+1: | Name of the theme. Be creative! |
| `author` | :+1: | Author of the theme/artwork. |
| `group` | :-1: | Group/affils of author. |
| `enabled` | :-1: | Boolean of enabled state. If set to `false`, this theme will not be available to your users. If a user currently has this theme selected, the system default will be selected for them at next login. |

### Customization Block
The `customization` block in is itself broken up into major parts:

| Item | Description                                              |
|-------------|---------------------------------------------------|
| `defaults` | Default values to use when this theme is active. These values override system defaults, but can still be overridden themselves in specific areas of your theme. |
| `menus` | The bulk of what you theme in the system will be here. Any menu (that is, anything you find in `menu.hjson`) can be tweaked. |
| `prompts` | Similar to `menus`, this section themes `prompts`. |

#### Defaults
Override system defaults.

| Item | Description                                              |
|-------------|---------------------------------------------------|
| `passwordChar` | Character to display in password fields. Defaults to `*` |
| `dateFormat` | Sets the [moment.js](https://momentjs.com/docs/#/displaying/) style `short` and/or `long` format for dates. |
| `timeFormat` | Sets the [moment.js](https://momentjs.com/docs/#/displaying/) style `short` and/or `long` format for times. |
| `dateTimeFormat` | Sets the [moment.js](https://momentjs.com/docs/#/displaying/) style `short` and/or `long` format for date/time combinations. |

Example:
```hjson
defaults: {
    dateTimeFormat: {
        short:  MMM Do h:mm a
    }
}
```

#### Menus Block
Each *key* in the `menus` block matches up with a key found in your `menu.hjson`. For example, consider a `matrix` menu defined in `menu.hjson`. In addition to perhaps providing a `MATRIX.ANS` in your themes directory, you can also theme other parts of the menu via a `matrix` entry in `theme.hjson`.

Major areas to override/theme:
* `config`: Override and/or provide additional theme information over that found in the `menu.hjson`'s entry. Common entries here are for further overriding date/time formats, and custom range info formats (`<someFormName>InfoFormat<num>`). See Entry Formatting in [MCI Codes](mci.md) and Custom Range Info Formatting below.
* `mci`: Set per-MCI code properties such as `height`, `width`, text styles, etc. See [MCI Codes](mci.md) for a more information.

Two formats for `mci` blocks are allowed:
* Shorthand if only a single/first form is needed.
* Verbose where a form ID(s) are supplied (required if multiple forms are used)

Example: Shorthand `mci` format:
```hjson
matrix: {
    mci: {
        VM1: {
            itemFormat: "|03{text}"
            focusItemFormat: "|11{text!styleFirstLower}"
        }
    }
}
```

Example: Verbose `mci` with form IDs:
```hjson
newUserFeedbackToSysOp: {
    0: {
        mci: {
            TL1: { width: 19, textOverflow: "..." }
            ET2: { width: 19, textOverflow: "..." }
            ET3: { width: 19, textOverflow: "..." }
        }
    }
    1: {
        mci: {
            MT1: { height: 14 }
        }
    }
}
```

##### Custom Range Info Formatting
Many modules support "custom range" MCI items. These are MCI codes that are left to the user to define using a format object specific to the module. For example, consider the `msg_area_list` module: This module sets MCI codes 10+ (`%TL10`, `%TL11`, etc.) as "custom range". When theming you can place these MCI codes in your artwork then define the format in `theme.hjson`:

```hjson
messageAreaChangeCurrentArea: {
    config: {
        areaListInfoFormat10: "|15{name}|07: |03{desc}"
    }
}
```

## Creating Your Own
:warning: ***IMPORTANT!*** Do not make any customizations to the included `luciano_blocktronics' theme. Instead, create your own and make changes to that instead:

1. Copy `/art/themes/luciano_blocktronics` to `art/themes/your_board_theme`
2. Update the `info` block at the top of the theme.hjson file:
``` hjson
info: {
    name: Awesome Theme
    author: Cool Artist
    group: Sick Group
    enabled: true // default
}
```

3. If desired, you may make this the default system theme in `config.hjson` via `theme.default`. `theme.preLogin` may be set if you want this theme used for pre-authenticated users. Both of these values also accept `*` if you want the system to randomly pick.
``` hjson
theme: {
    default: your_board_theme
    preLogin: *
}
```

## Theming Example
Let's run through an example!

Consider the following `menu.hjson` entry:
```hjson
superFancyMenu: {
    art: FANCY.ANS
    // ...some other stuff...
}
```

With a file of `FANCY.ANS` in `art/themes/fancy_theme` containing the following MCI codes:
* TL1 (Generic text label)
* BN2 (Predefined: Board Name)

An entry in your `theme.hjson` could look like this:
```hjson
superFancyMenu: {
    mci: {
        TL1: {
            //  supply the full format of the TL1 View
            text: |02ENiGMA|10½ |08v|03|VN
        }
        BN2: {
            //  Make Board Name l33t style
            style: l33t
        }
    }
}
```
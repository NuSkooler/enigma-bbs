---
layout: page
title: Themes
---
## Themes
ENiGMA½ comes with an advanced theming system allowing system operators to highly customize the look and feel of their boards. A given installation can have as many themes as you like for your users to choose from.

## General Information
Themes live in `art/themes/`. Each theme (and thus it's *theme ID*) is a directory within the `themes` directory. The theme itself is simply a collection of art files, and a `theme.hjson` file that further defines layout, colors & formatting, etc. ENiGMA½ comes with a default theme by [Luciano Ayres](http://blocktronics.org/tag/luciano-ayres/) of [Blocktronics](http://blocktronics.org/) called Mystery Skull. This theme is in `art/themes/luciano_blocktronics`, and thus it's *theme ID* is `luciano_blocktronics`.

## Theme Sections
Themes are have some important sections to be aware of:

* `info`: This section describes the theme. You may set the `enabled` field to `false` to disable it (Users assigned to this theme fall back to the default set in your `config.hjson`).
* `customization`: The beef!

### Theme Section: Customization
The `customization` block in `theme.hjson` is itself broken up into major parts:
* `defaults`: Default values to use when this theme is active. These values override system defaults, but can still be overridden themselves in specific areas of your theme.
* `menus`: The bulk of what you theme in the system will be here. Any menu (that is, anything you find in `menu.hjson`) can be tweaked.
* `prompts`: Similar to `menus`, this file themes prompts found in `prompts.hjson`.

TODO: More information about theming!


## Creating Your Own
:warning: ***IMPORTANT!*** It is recommended you don't make any customisations to the included `luciano_blocktronics' theme. Create your own and make changes to that instead:

1. Copy `/art/themes/luciano_blocktronics` to `art/themes/your_board_theme`
2. Update the `info` block at the top of the theme.hjson file:
``` hjson
    info: {
        name: Awesome Theme
        author: Cool Artist
        group: Sick Group
        enabled: true
    }
```

3. If desired, you may make this the default system theme in `config.hjson` via `theme.default`. `theme.preLogin` may be set if you want this theme used for pre-authenticated users. Both of these values also accept `*` if you want the system to radomly pick.
``` hjson
  theme: {
    default: your_board_theme
    preLogin: *
  }
```

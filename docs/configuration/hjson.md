---
layout: page
title: HJSON Config Files
---
## JSON for Humans!
HJSON is the configuration file format used by ENiGMA½ for [System Configuration](config-hjson.md), [Menus](menu-hjson.md), etc. [HJSON](https://hjson.org/) is is [JSON](https://json.org/) for humans!

For those completely unfamiliar, JSON stands for JavaScript Object Notation. But don't let that scare you! JSON is simply a text file format with a bit of structure ― kind of like a fancier INI file. HJSON on the other hand as mentioned previously, is JSON for humans. That is, it has the following features and more:

* More resilient to syntax errors such as missing a comma
* Strings generally do not need to be quoted. Multi-line strings are also supported!
* Comments are supported (JSON doesn't allow this!): `#`, `//` and `/* ... */` style comments are allowed.
* Keys never need to be quoted
* ...much more! See [the official HJSON website](https://hjson.org/).

## Terminology
Through the documentation, some terms regarding HJSON and configuration files will be used:

* `config.hjson`: Refers to `/path/to/enigma-bbs/config/config.hjson`. See [System Configuration](config-hjson.md).
* `menu.hjson`: Refers to `/path/to/enigma-bbs/config/<yourBBSName>-menu.hjson`. See [Menus](menu-hjson.md).
* Configuration *key*: Elements in HJSON are name-value pairs where the name is the *key*. For example, provided `foo: bar`, `foo` is the key.
* Configuration *section* or *block* (also commonly called an "Object" in code): This is referring to a section in a HJSON file that starts with a *key*. For example:
```hjson
someSection: {
    foo: bar
}
```
Note that `someSection` is the configuration *section* (or *block*) and `foo: bar` is within it.

## Editing HJSON
HJSON is a text file format, and ENiGMA½ configuration files **should always be saved as UTF-8**.

It is **highly** recommended to use a text editor that has HJSON support. A few (but not all!) examples include:
* [Sublime Text](https://www.sublimetext.com/) via the `sublime-hjson` package.
* [Visual Studio Code](https://code.visualstudio.com/) via the `vscode-hjson` plugin.
* [Notepad++](https://notepad-plus-plus.org) via the `npp-hjson` plugin.

See https://hjson.org/users.html for more more editors & plugins.

### Hot-Reload A.K.A. Live Editing
ENiGMA½'s configuration, menu, and theme files can edited while your BBS is running. When a file is saved, it is hot-reloaded into the running system. If users are currently connected and you change a menu for example, the next reload of that menu will show the changes.

:information_source: See also [Configuration Files](../configuration/config-files.md)

### CaSe SeNsiTiVE
Configuration keys are **case sensitive**. That means if a configuration key is `boardName` for example, `boardname`, or `BOARDNAME` **will not work**.

### Escaping
Some values need escaped. This is especially important to remember on Windows machines where file paths contain backslashes (`\`). To specify a path to `C:\foo\bar\baz.exe` for example, an entry may look like this in your configuration file:
```hjson
something: {
    path: "C:\\foo\\bar\\baz.exe" // note the extra \'s!
}
```

## Tips & Tricks
### JSON Compatibility
Remember that standard JSON is fully compatible with HJSON. If you are more comfortable with JSON (or have an editor that works with JSON that you prefer) simply convert your config file(s) to JSON and use that instead!

HJSON can be converted to JSON with the `hjson` CLI:
```bash
cd /path/to/enigma-bbs
cp ./config/config.hjson ./config/config.hjson.backup
./node_modules/hjson/bin/hjson ./config/config.hjson.backup -j > ./config/config.hjson
```

You can always convert back to HJSON by omitting `-j` in the command above.

### oputil
You can easily dump out your current configuration in a pretty-printed style using oputil: ```./oputil.js config cat```

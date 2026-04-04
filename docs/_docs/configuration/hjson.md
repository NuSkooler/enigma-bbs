---
layout: page
title: HJSON Config Files
---
## JSON for Humans!
HJSON is the configuration file format used by ENiGMA½ for [System Configuration](config-hjson.md), [Menus](menu-hjson.md), etc. [HJSON](https://hjson.github.io/) is [JSON](https://json.org/) for humans!

For those completely unfamiliar, JSON stands for JavaScript Object Notation. But don't let that scare you! JSON is simply a text file format with a bit of structure ― kind of like a fancier INI file. HJSON on the other hand as mentioned previously, is JSON for humans. That is, it has the following features and more:

* More resilient to syntax errors such as missing a comma
* Strings generally do not need to be quoted. Multi-line strings are also supported!
* Comments are supported (JSON doesn't allow this!): `#`, `//` and `/* ... */` style comments are allowed.
* Keys never need to be quoted
* ...much more! See [the official HJSON website](https://hjson.github.io/).

> :bulb: Not sure your HJSON is valid? Try it in the [live HJSON playground](https://hjson.github.io/try.html) before editing your config files!

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

It is **highly** recommended to use a text editor that has HJSON support to get syntax highlighting and catch errors early.

### Visual Studio Code
The [vscode-hjson](https://marketplace.visualstudio.com/items?itemName=laktak.hjson) extension provides syntax highlighting for `.hjson` files and is available directly from the VS Code marketplace. This is the recommended option for most users.

### Other Editors
Several other editors have HJSON plugins available. The [official HJSON users page](https://hjson.github.io/users.html) has a current list. Note that plugins for **Sublime Text** (`sublime-hjson`) and **Notepad++** (`npp-hjson`) exist but are no longer actively maintained — they still work for basic syntax highlighting but may have rough edges on newer editor versions.

### Hot-Reload A.K.A. Live Editing
ENiGMA½'s configuration, menu, and theme files can be edited while your BBS is running. When a file is saved, it is hot-reloaded into the running system. If users are currently connected and you change a menu for example, the next reload of that menu will show the changes.

> :information_source: See also [Configuration Files](../configuration/config-files.md)

### CaSe SeNsiTiVE
Configuration keys are **case sensitive**. That means if a configuration key is `boardName` for example, `boardname`, or `BOARDNAME` **will not work**.

### Escaping
Some values need escaped. This is especially important to remember on Windows machines where file paths contain backslashes (`\`). To specify a path to `C:\foo\bar\baz.exe` for example, an entry may look like this in your configuration file:
```hjson
something: {
    path: "C:\\foo\\bar\\baz.exe" // note the extra \'s!
}
```

> :information_source: Escape sequences (like `\\`) only work inside **double-quoted** strings. Unquoted values are taken literally and do not support escaping.

## Common Pitfalls

### `#` Is Always a Comment
In HJSON, `#` starts a comment anywhere it appears as the first non-whitespace character of an unquoted value. This catches people out with hex color codes or similar values:

```hjson
// Wrong — "color" will be empty; everything after # is a comment:
color: #FF0000

// Correct — quote the value:
color: "#FF0000"
```

### Numbers vs. Strings
HJSON automatically interprets unquoted values that look like numbers as actual numbers, and `true`/`false` as booleans. ENiGMA½ configuration expects the correct type — passing a quoted string where a number is expected (or vice versa) will cause errors:

```hjson
// Correct — port is a number, boardName is a string:
port: 8810
boardName: My Awesome BBS

// Wrong — port will be the string "8810", not the number 8810:
port: "8810"
```

### Unquoted Strings Have Limits
Unquoted string values are convenient but cannot span multiple lines and do not support escape sequences. If your value contains special characters, leading/trailing whitespace, or needs to span multiple lines, use quotes.

For **multi-line strings**, HJSON supports triple-quoted blocks:

```hjson
welcomeMessage:
    '''
    Welcome to my BBS!
    We hope you enjoy your stay.
    '''
```

The indentation matching the opening `'''` is automatically stripped from each line.

### Root Braces Are Omitted
ENiGMA½ config files omit the outer `{ }` that you would see in standard JSON. This is valid HJSON — the parser wraps the content in an implicit root object. Don't add them.

## Tips & Tricks

### Validating Your Config
Before starting ENiGMA½, you can validate your config files using the bundled `hjson` CLI. If there is a syntax error it will report the exact line number:

```bash
./node_modules/hjson/bin/hjson ./config/config.hjson
```

A clean parse will pretty-print the file. An error will show the line and column of the problem. This is much faster than starting ENiGMA and hunting through logs.

### Inspecting Your Live Config
You can dump your current merged configuration in a pretty-printed style using oputil:

```bash
./oputil.js config cat
```

This is useful for verifying that hot-reloaded changes were applied correctly and that your overrides merged as expected.

### JSON Compatibility
Remember that standard JSON is fully compatible with HJSON. If you are more comfortable with JSON (or have an editor that works with JSON that you prefer) simply convert your config file(s) to JSON and use that instead!

HJSON can be converted to JSON with the `hjson` CLI:
```bash
cd /path/to/enigma-bbs
cp ./config/config.hjson ./config/config.hjson.backup
./node_modules/hjson/bin/hjson ./config/config.hjson.backup -j > ./config/config.hjson
```

You can always convert back to HJSON by omitting `-j` in the command above.

# Introduction
This document covers basic upgrade notes for major ENiGMA½ version updates.


# Before Upgrading
* Always back up your system! 
* At least back up the `db` directory and your `menu.hjson` (or renamed equivalent)


# General Notes
Upgrades often come with changes to the default `menu.hjson`. It is wise to 
use a *different* file name for your BBS's version of this file and point to
it via `config.hjson`. For example:

```hjson
general: {
	menuFile: my_bbs.hjson
}
```

After updating code, use a program such as DiffMerge to merge in updates to
`my_bbs.hjson` from the shipping `menu.hjson`.


# Upgrading the Code
Upgrading from GitHub is easy:

```bash
cd /path/to/enigma-bbs
git pull
rm -rf npm_modules # do this any time you update Node.js itself
npm install
```


# Problems
Report your issue on Xibalba BBS, hop in #enigma-bbs on Freenet and chat, or
[file a issue on GitHub](https://github.com/NuSkooler/enigma-bbs/issues).

# 0.0.8-alpha to 0.0.9-alpha
* Development is now against Node.js 10.x LTS. Follow your standard upgrade path to update to Node 10.x before using 0.0.9-alpha!
* The property `justify` found on various views previously had `left` and `right` values swapped (oops!); you will need to adjust any custom `theme.hjson` that use one or the other and swap them as well.
* Possible breaking changes in FSE: The MCI code `%TL13` for error indicator is now `%TL4`. This is part of a cleanup and standardization on "custom ranges". You may need to update your `theme.hjson` and related artwork.
* Removed view width auto-size: Some views still can auto-size their height, but in general you should be explicit in your themes
* More standardization using "custom ranges" and `itemFormat` / `focusItemFormat` semantics. Update your themes!
* In addition to using `itemFormat`, the `onelinerz` module uses `userName` vs `username` (note the case) to match other modules
* `loginServers.webSocket` configuration block has changed to be more consistent with other servers. Example:
```
webSocket: {
    ws: {
        enabled: true
    }
    wss: {
        enabled: true
        port: 1234
    }
    proxied: true	//	X-Forwarded-Proto: https support
}
```
* The module export `registerEvents` has been deprecated. If you have a module that depends on this, use the new more generic `moduleInitialize` export instead.
* The `system.db` `user_event_log` table has been updated to include a unique session ID. Previously this table was not used, but you will need to perform a slight maintenance task before it can be properly used. After updating to `0.0.9-alpha`, please run the following: `sqlite3 db/system.db DROP TABLE user_event_log;`. The new table format will be created and used at startup.
* If you have art configured for message conference or area selection via the `art` configuration value, you will need to include a `show_art` menu reference. Defaulted to `changeMessageConfPreArt` for conferences and `changeMessageAreaPreArt` for areas & included in the example `menu.hjson`.
* Config `defaults` section was theme related and as such, has been renamed to `theme`. `defaults.theme` is now `theme.default`, and `preLoginTheme` is now `theme.preLogin`. See `config.js` if this isn't clear as mud.
* Similar to the last item, `defaults.general.passwordChar` in `theme.hjson` is now just `defaults.passwordChar`.


# 0.0.7-alpha to 0.0.8-alpha
ENiGMA 0.0.8-alpha comes with some structure changes:
* Configuration files are defaulted to `./config`. Related, the `--config` option now points to a configuration **directory**
* `./mods/art` has been moved to `./art/general`
* `./mods` is now reserved for actual user addon modules
* Themes have been moved from `./mods/themes` to `./art/themes`

With the change to the `./mods` directory, `@systemModule` is now implied for `module` declarations in `menu.hjson`. To use a user module in `./mods` you must specify `@userModule`!

With the above changes, you'll need to to at least:
* Move your `~/.config/enigma-bbs/config.hjson` to `./config/config.hjson` or utlize the `--config` option. 
* Move your `prompt.hjson` and `menu.hjson` (e.g. `myboardname.hjson`) to `./config`
* Move any non-theme art files, and theme directories to their appropriate locations mentioned above
* Move any module directories such as `message_post_evt` to `./mods/`
* Move any certificates, pub/private keys, etc. from `./misc` to `./config`
* Specify user modules as `@userModule:my_module_name`

# 0.0.6-alpha to 0.0.7-alpha
No issues

# 0.0.5-alpha to 0.0.6-alpha
No issues

# 0.0.4-alpha to 0.0.5-alpha
No issues

# 0.0.1-alpha to 0.0.4-alpha
## Node.js 6.x+ LTS is now **required**
You will need to upgrade Node.js to [6.x+](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V6.md). If using [nvm](https://github.com/creationix/nvm) (you should be!) the process will go something like this:
```bash
nvm install 6
nvm alias default 6
```

### ES6
Newly written code will use ES6 and a lot of code has started the migration process. Of note is the `MenuModule` class. If you have created a mod that inherits from `MenuModule`, you will need to upgrade your class to ES6.

## Manual Database Upgrade
A few upgrades need to be made to your SQLite databases:

```bash
rm db/file.sqltie3 # safe to delete this time as it was not used previously
sqlite3 db/message.sqlite
sqlite> INSERT INTO message_fts(message_fts) VALUES('rebuild');
```

## Archiver Changes
If you have overridden or made additions to archivers in your `config.hjson` you will need to update them. See [Archive Configuration](docs/archive.md) and `core/config.js`

## File Base Configuration
As 0.0.4-alpha contains file bases, you'll want to create a suitable configuration if you wish to use the feature. See [File Base Configuration](docs/file_base.md).

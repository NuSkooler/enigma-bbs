# Whats New
This document attempts to track **major** changes and additions in ENiGMA½. For details, see GitHub.

## 0.0.13-beta
* **Note for contributors**: ENiGMA has switched to [Prettier](https://prettier.io) for formatting/style. Please see [CONTRIBUTING](CONTRIBUTING.md) and the Prettier website for more information.
* Removed terminal `cursor position reports` from most locations in the code. This should greatly increase the number of terminal programs that work with Enigma 1/2. For more information, see [Issue #222](https://github.com/NuSkooler/enigma-bbs/issues/222). This may also resolve other issues, such as [Issue #365](https://github.com/NuSkooler/enigma-bbs/issues/365), and [Issue #320](https://github.com/NuSkooler/enigma-bbs/issues/320). Anyone that previously had terminal incompatibilities please re-check and let us know!
* Bumped up the minimum [Node.js](https://nodejs.org/en/) version to v14. This will allow more expressive Javascript programming syntax with ECMAScript 2020 to improve the development experience.
* Added new configuration options for `term.checkUtf8Encoding`, `term.checkAnsiHomePostion`, `term.cp437TermList`, and `term.utf8TermList`. More information on these options is available in [UPGRADE](UPGRADE.md).
* Many additional backward-compatible bug fixes since the first release of 0.0.12-beta. See the [project repository](https://github.com/NuSkooler/enigma-bbs) for more information.

## 0.0.12-beta
* The `master` branch has become mainline. What this means to users is `git pull` will always give you the latest and greatest. Make sure to read [Updating](./docs/admin/updating.md) and keep an eye on `WHATSNEW.md` (this file) and [UPGRADE](UPGRADE.md)! See also [ticket #276](https://github.com/NuSkooler/enigma-bbs/issues/276).
* Development now occurs against [Node.js 14 LTS](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V14.md).
* The default configuration has been moved to [config_default.js](/core/config_default.js).
* A full configuration revamp has taken place. Configuration files such as `config.hjson`, `menu.hjson`, and `theme.hjson` can now utilize includes via the `includes` directive, reference 'self' sections using `@reference:` and import environment variables with `@environment`.
* An explicit prompt file previously specified by `general.promptFile` in `config.hjson` is no longer necessary. Instead, this now simply part of the `prompts` section in `menu.hjson`. The default setup still creates a separate prompt HJSON file, but it is `includes`ed in `menu.hjson`. With the removal of prompts the `PromptsChanged` event will no longer be fired.
* New `PV` ACS check for arbitrary user properties. See [ACS](./docs/configuration/acs.md) for details.
* The `message` arg used by `msg_list` has been deprecated. Please starting using `messageIndex` for this purpose. Support for `message` will be removed in the future.
* Added ability to export/download messages. This is enabled in the default menu. See `messageAreaViewPost` in [the default message base template](./misc/menu_templates/message_base.in.hjson) and look for the download options (`@method:addToDownloadQueue`, etc.) for details on adding to your system!
* The Gopher server has had a revamp! Standard `gophermap` files are now served along with any other content you configure for your Gopher Hole! A default [gophermap](https://en.wikipedia.org/wiki/Gopher_(protocol)#Source_code_of_a_menu) can be found [in the misc directory](./misc/gophermap) that behaves like the previous implementation. See [Gopher docs](./docs/servers/gopher.md) for more information.
* Default file browser up/down/pageUp/pageDown scrolls description (e.g. FILE_ID.DIZ). If you want to expose this on an existing system see the `fileBaseListEntries` in the default `file_base.in.hjson` template.
* File base search has had an improvement to search term handling.
* `./oputil user group -group` to now accepts `~group` removing the need for special handling of the "-" character. #331
* A fix has been made to clean up old `file.db` entries when a file is removed. Previously stale records could be left or even recycled into new entries. Please see [UPGRADE.md](UPGRADE.md) for details on applying this fix (look for `tables_update_2020-11-29.sql`).
* The [./docs/modding/onelinerz.md](onelinerz) module can have `dbSuffix` set in it's `config` block to specify a separate DB file. For example to use as a requests list.
* Default hash tags can now be set in file areas. Simply supply an array or list of values in a file area block via `hashTags`.
* Added ability to pass an `env` value (map) to `abracadabra` doors. See [Local Doors](./docs/modding/local-doors.md]).
* `dropFileType` is now optional when launching doors with `abracadabra`. It can also be explicitly set to `none`.
* FSE in *view* mode can now stylize quote indicators. Supply `quoteStyleLevel1` in the `config` block. This can be a single string or an array of two strings (one to style the quotee's initials, the next for the '>' character, and finally the quoted text). See the `messageAreaViewPost` menu `config` block in the default `luciano_blocktronics` `theme.hjson` file for an example. An additional level style (e.g. for nested quotes) may be added in the future.
* FSE in *view* mode can now stylize tear lines and origin lines via `tearLineStyle` and `originStyle` `config` values in the same manor as `quoteStyleLevel`.

## 0.0.11-beta
* Upgraded from `alpha` to `beta` -- The software is far along and mature enough at this point!
* Development is now against Node.js 12.x LTS. Other versions may work but are not currently supported!
* [QWK support](./docs/messageareas/qwk.md)
* `oputil fb scan *areaTagWildcard*` scans all areas in which wildcard is matched.
* The archiver configuration `escapeTelnet` has been renamed `escapeIACs`. Support for the old value will be removed in the future.

## 0.0.10-alpha
+ `oputil.js user rename USERNAME NEWNAME`
+ `my_messages.js` module (defaulted to "m" at the message menu) to list public messages addressed to the currently logged in user. Takes into account their username and `real_name` property.
+ SSH Public Key Authentication has been added. The system uses a OpenSSH style public key set on the `ssh_public_key` user property.
+ 2-Factor (2FA) authentication is now available using [RFC-4266 - HOTP: HMAC-Based One-Time Password Algorithm)](https://tools.ietf.org/html/rfc4226), [RFC-6238 - TOTP: Time-Based One-Time Password Algorithm](https://tools.ietf.org/html/rfc6238), or [Google Authenticator](http://google-authenticator.com/). QR codes for activation are available as well. One-time backup aka recovery codes can also be used. See [Security](./docs/configuration/security.md) for more info!
* New ACS codes for new 2FA/OTP: `AR` and `AF`. See [ACS](./docs/configuration/acs.md) for details.
+ `oputil.js user 2fa USERNAME TYPE` enables 2-factor authentication for a user.
* `oputil.js user info USERNAME --security` can now display additional security information such as 2FA/OTP.
* `oputil.js fb scan --quick` is now the default. Override with `--full`.
* ACS checks can now be applied to form actions. For example:
```hjson
{
    value: { command: "SEC" }
    action: [
        {
            //  secure connections can go here
            acs: SC
            action: @menu:securityMenu
        }
        {
            //  non-secure connections
            action: @menu:secureConnectionRequired
        }
    ]
}
```
* `idleLogoutSeconds` and `preAuthIdleLogoutSeconds` can now be set to `0` to fully disable the idle monitor.
* Switched default archive handler for zip files from 7zip to InfoZip (`zip` and `unzip`) commands. See [UPGRADE](UPGRADE.md).
* Menu submit `action`'s can now in addition to being a simple string such as `@menu:someMenu`, or an array of objects with ACS checks, be a simple array of strings. In this case, a random match will be made. For example:
```hjson
submit: [
    {
        value: { command: "FOO" }
        action: [
            // one of the following actions will be matched:
            "@menu:menuStyle1"
            "@menu:menuStyle2"
        ]
    }
]
```
* Added `read` (list/view) and `write` (post) ACS support to message conferences and areas.
* Many new built in modules adding support for things like auto signatures, listing "my" messages, top stats, etc. Take a look in the docs for setting them up!
* Built in MRC support!
* Added an customizable achievement system!


## 0.0.9-alpha
* Development is now against Node.js 10.x LTS. While other Node.js series may continue to work, you're own your own and YMMV!
* Fixed `justify` properties: `left` and `right` values were formerly swapped (oops!)
* Menu items can now be arrays of *objects* not just arrays of strings.
  * The properties `itemFormat` and `focusItemFormat` allow you to supply the string format for items. For example if a menu object is `{ "userName" : "Bob", "age" : 35 }`, a `itemFormat` might be `|04{userName} |08- |14{age}`.
  * If no `itemFormat` is supplied, the default formatter is `{text}`.
  * Setting the `data` member of an object will cause form submissions to use this value instead of the selected items index.
  * See the default `luciano_blocktronics` `matrix` menu for example usage.
* You can now set the `sort` property on a menu to sort items. If `true` items are sorted by `text`. If the value is a string, it represents the key in menu objects to sort by.
* Hot-reload of configuration files such as menu.hjson, config.hjson, your themes.hjson, etc.: When a file is saved, it will be hot-reloaded into the running system
  * Note that any custom modules should make use of the new Config.get() method.
* The old concept of `autoScale` has been removed. See https://github.com/NuSkooler/enigma-bbs/issues/166
* Ability to delete from personal mailbox (finally!)
* Add ability to skip file and/or message areas during newscan. Set config.omitFileAreaTags and config.omitMessageAreaTags in new_scan configuration of your menu.hjson
* `{userName}` (sanitized) and `{userNameRaw}` as well as `{cwd}` have been added to param options when launching a door.
* Any module may now register for a system startup initialization via the `initializeModules(initInfo, cb)` export.
* User event log is now functional. Various events a user performs will be persisted to the `system.sqlite3` `user_event_log` table for up to 90 days. An example usage can be found in the updated `last_callers` module where events are turned into Ami/X style actions. Please see `UPGRADE.md`!
* New MCI codes including general purpose movement codes. See [MCI codes](docs/art/mci.md)
* `install.sh` will now attempt to use NPM's `--build-from-source` option when ARM is detected.
* `oputil.js config new` will now generate a much more complete configuration file with comments, examples, etc. `oputil.js config cat` dumps your current config to stdout.
* Handling of failed login attempts is now fully in. Disconnect clients, lock out accounts, ability to auto or unlock at (email-driven) password reset, etc. See `users.failedLogin` in `config.hjson`.
* NNTP support! See [NNTP docs](./docs/servers/nntp.md) for more information.
* `oputil.js user rm` and `oputil.js user info` are in! See [oputil CLI](./docs/admin/oputil.md).
* Performing a file scan/import using `oputil.js fb scan` now recognizes various `FILES.BBS` formats.
* Usernames found in the `config.users.badUserNames` are now not only disallowed from applying, but disconnected at any login attempt.
* Total minutes online is now tracked for users. Of course, it only starts after you get the update :)
* Form entries in `menu.hjson` can now be omitted from submission handlers using `omit: true`

## 0.0.8-alpha
* [Mystic BBS style](http://wiki.mysticbbs.com/doku.php?id=displaycodes) extended pipe color codes. These allow for example, to set "iCE" background colors.
* File descriptions (FILE_ID.DIZ, etc.) now support Renegade |## pipe, PCBoard, and other less common color codes found commonly in BBS era scene releases.
* New menu stack flags: `noHistory` now works as expected, and a new addition of `popParent`. See the default `menu.hjson` for usage.
* File structure changes making ENiGMA½ much easier to maintain and run in Docker. Thanks to RiPuk ([Dave Stephens](https://github.com/davestephens))! See [UPGRADE.md](UPGRADE.md) for details.
* Switch to pure JS [xxhash](https://github.com/mscdex/node-xxhash) instead of farmhash. Too many issues on ARM and other less popular CPUs with farmhash ([Dave Stephens](https://github.com/davestephens))
* Native [CombatNet](http://combatnet.us/) support! ([Dave Stephens](https://github.com/davestephens))
* Fix various issues with legacy DOS Telnet terminals. Note that some may still have issues with extensive CPR usage by ENiGMA½ that will be addressed in a future release.
* Added web (http://, https://) based download manager including batch downloads. Clickable links if using [VTXClient](https://github.com/codewar65/VTX_ClientServer)!
* General VTX hyperlink support for web links
* DEL vs Backspace key differences in FSE
* Correctly parse oddball `INTL`, `TOPT`, `FMPT`, `Via`, etc. FTN kludge lines
* NetMail support! You can now send and receive NetMail. To send a NetMail address a external user using `Name <address>` format from your personal email menu. For example, `Foo Bar <123:123/123>`. The system also detects other formats such asa `Name @ address` (`Foo Bar@123:123/123`)
* `oputil.js`: Added `mb areafix` command to quickly send AreaFix messages from the command line. You can manually send them from personal mail as well.
* `oputil.js fb rm|remove|del|delete` functionality to remove file base entries.
* `oputil.js fb desc` for setting/updating a file entry description.
* Users can now (re)set File and Message base pointers
* Add `--update` option to `oputil.js fb scan`
* Fix @watch path support for event scheduler including FTN, e.g. when looking for a `toss!.now` file produced by Binkd.

...LOTS more!

## Pre 0.0.8-alpha
See GitHub

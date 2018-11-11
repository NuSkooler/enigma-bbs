# Whats New
This document attempts to track **major** changes and additions in ENiGMA½. For details, see GitHub.

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
* `{userName}` (sanatized) and `{userNameRaw}` as well as `{cwd}` have been added to param options when launching a door.
* Any module may now register for a system startup intiialization via the `initializeModules(initInfo, cb)` export.
* User event log is now functional. Various events a user performs will be persisted to the `system.db` `user_event_log` table for up to 90 days. An example usage can be found in the updated `last_callers` module where events are turned into Ami/X style actions. Please see `UPGRADE.md`!
* New MCI codes including general purpose movement codes. See [MCI codes](docs/art/mci.md)
* `install.sh` will now attempt to use NPM's `--build-from-source` option when ARM is detected.
* `oputil.js config new` will now generate a much more complete configuration file with comments, examples, etc. `oputil.js config cat` dumps your current config to stdout.



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
* Correly parse oddball `INTL`, `TOPT`, `FMPT`, `Via`, etc. FTN kludge lines
* NetMail support! You can now send and receive NetMail. To send a NetMail address a external user using `Name <address>` format from your personal email menu. For example, `Foo Bar <123:123/123>`. The system also detects other formats such asa `Name @ address` (`Foo Bar@123:123/123`)
* `oputil.js`: Added `mb areafix` command to quickly send AreaFix messages from the command line. You can manually send them from personal mail as well.
* `oputil.js fb rm|remove|del|delete` functionality to remove file base entries
* Users can now (re)set File and Message base pointers
* Add `--update` option to `oputil.js fb scan`
* Fix @watch path support for event scheduler including FTN, e.g. when looking for a `toss!.now` file produced by Binkd.

...LOTS more!

## Pre 0.0.8-alpha
See GitHub
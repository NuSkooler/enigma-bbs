# Whats New
This document attempts to track **major** changes and additions in ENiGMA½. For details, see GitHub.

## 0.2.0-beta

* **SQLite driver migrated to `better-sqlite3`** -- This is an internal change with no impact on existing data or configuration. Results in some major DB performance gains.

## 0.1.1-beta

* **NNTP server improvements** -- several protocol compliance and reliability fixes:
  * Article posting now correctly detects end-of-post and handles CRLF line endings
  * `AUTHINFO USER` is now advertised in `CAPABILITIES` so clients know to authenticate before posting
  * `Xref` header is now generated, improving cross-session read tracking in NNTP clients
  * Newsgroups header parsing is more robust (null-safe, whitespace-tolerant)
  * Group message cache TTL increased from 30s to 5 minutes

## 0.1.0-beta

* **[Sysop Chat / Break Into Chat](./docs/_docs/modding/sysop-chat.md)** — real-time split-screen chat between sysop and user

  * Sysop can break into chat with any node directly from WFC (`B` key on selected node)
  * Users can page the sysop via the `pageSysop` menu entry; includes per-user rate limiting and BEL + interrupt notification to all online sysops (sysops at WFC see it directly in the node list)
  * If no sysop is available, users are offered the option to send their message as private mail instead
  * Both parties share the same `sysopChat` module with role-based panel routing (sysop messages top, user messages bottom)
  * Status line uses the standard custom-range token system (`chatInfoFormat10`, etc.) — fully themable
  * WFC node list gains a `{pageIndicator}` token per row — non-empty when that node has a pending page; configurable via `pageIndicator` in the WFC `config` block
  * WFC custom tokens `{pendingPageCount}`, `{pendingPageUser}`, `{pendingPageNode}`, `{pendingPageMessage}` for surfacing page queue state in art
  * **`prefixFormat`** property on `EditTextView` — set per-view in `theme.hjson` to display a role-specific prefix before the input (e.g. `"|15{userName}|07> "`); pipe codes render live as the user types; cursor and scroll account for the prefix width automatically

* **Pause Prompt Improvements** — see [Pause Prompts](./docs/_docs/art/pause-prompts.md) for the full reference

  * `pause: pageBreak` — art is paginated and displayed screen-by-screen with a prompt between pages; detects absolute-positioning ANSI and falls back to single-page display automatically
  * `pause: '<promptId>'` — shorthand: end-mode pause using the named prompt; equivalent to `pause: true` + `pausePrompt: <promptId>`
  * `pausePrompt` — per-menu override of the prompt name used for end-of-art and/or page-break pauses; accepts a string (same prompt for both) or `{ end, page }` object for independent control
  * `pausePosition` — per-menu `{ row, col }` override to force the pause prompt to a specific screen position
  * `continuousKey` / `quitKey` — configurable keys on the `pausePage` prompt to skip remaining page breaks or abort all remaining pages entirely
  * `pausePage` system prompt — add this alongside `pause` in your `prompts` block to customise page-break behavior; supports all MCI views including `%TK` (TickerView) for animated instructions
  * Pipe color codes in TickerView `text` are now preserved across all non-dynamic motion styles (`bounce`, `reveal`, `typewriter`, `fallLeft`/`fallRight`) — color survives scrolling
  * *Module developers:* `displayThemedPause` / `displayThemedPrompt` (when `pause: true`) callbacks now receive a third argument `pressedKey: { ch, key }`. Existing callers that ignore extra arguments are unaffected.

* **New MCI View Types**

  * **[TickerView](./docs/_docs/art/views/ticker_view.md) (`%TK`)** — animated single-line marquee with a two-axis model; works in any context including pause prompts (see above):
    * **Motion styles**: `left`, `right`, `bounce`, `reveal`, `typewriter`, `fallLeft`, `fallRight`
      * `fallLeft`/`fallRight`: characters spread across the window with increasing inter-char gaps toward the source edge, then all slide at 1 col/tick and stack against the target edge — a "stack of bricks" effect
    * **Effects**: text-style effects (`upper`, `lower`, `title`, `l33t`, `mixed`, and more) baked at set-time; dynamic per-tick effects (`rainbow`, `scramble`, `glitch`)
    * Text-style and dynamic effects are independent axes and can be freely combined (e.g. `l33t` + `rainbow`)
    * `scramble` renders each character's noise in its own pipe color with reverse-video; `glitch` uses `styleSGR2` for corruption color
    * Redraw optimization: ticks where the rendered output hasn't changed (e.g. `bounce` at rest, hold phases) are skipped entirely — no unnecessary cursor movement
    * All configuration via `mci` block in `menu.hjson` / `theme.hjson` — no inline MCI args needed
    * `destroy()` clears timers; view teardown in `ViewController` now calls `destroy()` on all views, fixing timers surviving menu transitions
  * **[StatusBarView](./docs/_docs/art/views/status_bar_view.md) (`%SB`)** — single-line view with two modes:
    * **Single mode**: auto-refreshing text label that re-renders a format template on a configurable `refreshInterval`; skips redraws when text hasn't changed
    * **Panel mode** (`panels` array): divides the view into independently-addressable named slots, each with its own width, alignment, color, fill character, and optional auto-refresh template. Panels are updated from code via `setPanel(name, value)` / `setPanels(updates)` without touching adjacent slots. A panel's `text` property (without `refreshInterval`) sets a static initial value evaluated once at init — useful for fixed label prefixes configured entirely from `menu.hjson`.
  * **FSE editor footer** now uses a single `%SB1` in panel mode (replacing the old separate `%TL1`/`%TL2` views) — displays cursor position and INS/OVR mode side-by-side, updated live as the cursor moves. See [UPGRADE](UPGRADE.md) if you have custom FSE art or menu config.

* **View System Modernization**

  * Converted the entire view system from `util.inherits`/prototype patterns to **ES6 classes**: `View`, `TextView`, `EditTextView`, `MaskEditTextView`, `ButtonView`, `MenuView`, `HorizontalMenuView`, `VerticalMenuView`, `FullMenuView`, `ToggleMenuView`, `SpinnerMenuView`, `MultiLineEditTextView`, `ViewController`
  * Numerous bug fixes applied during conversion (position defaults, SGR field aliasing, `key_entry_view.js` boolean logic, `color_codes.js` WWIV/CNET capture groups, `horizontal_menu_view.js` height, `multi_line_edit_text_view.js` `tabStops` binding)
  * New **[LineBuffer](./core/line_buffer.js)** — isolated, view-dependency-free line storage using `Uint32` per-character attribute words (fg, bg, bold, blink, underline, italic, strikethrough, color source, true-color flags); soft/hard EOL tracking; word-boundary wrap with character-break fallback
  * **EditTextView** and **MaskEditTextView** are now backed by `LineBuffer`: cursor-aware insert/delete at any position, left/right/home/end movement with scroll-window tracking, forward-delete, fixed partial-fill `getData()` bug in `MaskEditTextView`
  * **`client_term.js`**: `beginWrite()` / `commitWrite()` with nesting support — all writes within a keypress or focus switch are buffered and flushed as a single socket write, eliminating intermediate cursor flicker in terminals

* **`oputil user` SSH Key Management**

  * `oputil.js user import-ssh-key USERNAME KEYFILE` — imports a SSH public key for a user from a file, validates the key, and stores it for SSH key-based login
  * `oputil.js user remove-ssh-key USERNAME` — removes a user's stored SSH public key
  * `oputil.js user info USERNAME` now displays SSH key info (algorithm, SHA256 fingerprint, comment) when a key is on file

* **File Base: Wildcard/Recursive Storage Tags** ([#194](https://github.com/NuSkooler/enigma-bbs/issues/194))

  Appending `/*` to a storage tag path enables recursive scanning of all subdirectories:

  ```hjson
  storageTags: {
      scene_files: "/path/to/scene/*"   // walks all subdirs
  }
  ```

  * Files found in subdirectories are indexed with their `relPath` (e.g. `2024/April`) stored in the database, so same-named files in different subdirectories are tracked as distinct entries.
  * When an area mixes flat and wildcard tags, flat tags are scanned first and their directories are excluded from wildcard scans to prevent double-indexing.
  * `.enigmaignore` files (gitignore syntax) can be placed anywhere in a wildcard tree to exclude files or directories from scanning.
  * Startup warns on malformed wildcard patterns (e.g. a bare `*` not at the trailing `/*` position).
  * New database column `storage_tag_rel_path`; automatically added to existing installations on first startup.

* **Bug Fixes & Stability**

  * Fixed ENiGMA segfault on ARM64 Linux (Raspberry Pi) — see [#620](https://github.com/NuSkooler/enigma-bbs/issues/620)
  * Improved `install.sh`: better distutils availability check ([#631](https://github.com/NuSkooler/enigma-bbs/issues/631)), additional script improvements

## 0.0.14-beta

* **ActivityPub & Mastodon Support (Experimental)**

  * A new [ActivityPub Web Handler](./docs/_docs/servers/contentservers/activitypub-handler.md) has been added.
  * ⚠️ **WARNING**: ActivityPub is **disabled by default**. There may be **security implications**, federation may be **unstable**, and some parts may not work yet. **Use at your own risk!**
  * Provides groundwork for federated features: WebFinger discovery, NodeInfo2, actor profiles/avatars, inbox/outbox/shared inbox, and handling of common ActivityPub object types (`Note`, `Accept`, `Undo`, followers/following).
  * **WebFinger** and **NodeInfo2** handlers are also disabled by default. These may be useful for inter-BBS or other integrations, but note: WebFinger may still “advertise” ActivityPub endpoints even if AP itself is off.
  * Cool new functionality arrives with or without AP enabled:

    * **PNG Avatars**: users now get avatars (including **auto-generated defaults**) that can be served via the web frontend.
    * Message editor and timeline improvements:

      * Recognition of `@user@domain` addressing (Fediverse general)
      * Unicode → ASCII transliteration for federated messages (via AnyAscii). ...but we can use it for any <-> web!
    * **Better routing** for web handlers and `.well-known` paths.
    * **Dedicated web logging** under `contentHandlers.web.logging`.
    * TONS of fixes and improvements to the code base

    The fate of full ActivityPub support in ENiGMA is till up in the air...

* **[Web Server](/docs/_docs/servers/contentservers/web-server.md) Changes** (⚠️ some may be breaking):

  * `/static/` prefixes are no longer required (ugly hack removed).
  * Internal routes (e.g. password reset) now live under `/_enig/`.
  * File base routes now default to `/_f/` instead of `/f/`. If your `config.hjson` still uses `/f/`, update it.
  * The system will now search for `index.html` then `index.htm` if a suitable route cannot be found.
  * [Web Handler](/docs/_docs/servers/contentservers/web-handlers.md) modules are now easier to add; several exist by default.

* **Other Additions & Changes**

  * New users now have randomly generated avatars assigned (served via System General [Web Handler](/docs/_docs/servers/contentservers/web-handlers.md)).
  * CombatNet has shut down; the module (`combatnet.js`) has been removed.
  * New `NewUserPrePersist` system event available for developers to hook into account creation.
  * `viewValidationListener` callback signature has changed: now `(err, newFocusId)`. To ignore a validation error, call with `null` for `err`.
  * The Menu Flag `popParent` has been removed; `noHistory` has been updated to work as expected. See [UPGRADE](UPGRADE.md).
  * Various New User Application (NUA) properties are now optional. Remove optional fields from NUA artwork if you wish to collect less information (stored as empty string). Optional properties: Real name, Birth date, Sex, Location, Affiliations (Affils), Email, Web address.
  * Art handling now respects art width from SAUCE metadata when terminal width is greater, fixing display issues on wide UTF-8 terminals.

## 0.0.13-beta
* **Note for contributors**: ENiGMA has switched to [Prettier](https://prettier.io) for formatting/style. Please see [CONTRIBUTING](CONTRIBUTING.md) and the Prettier website for more information.
* Removed terminal `cursor position reports` from most locations in the code. This should greatly increase the number of terminal programs that work with Enigma 1/2. For more information, see [Issue #222](https://github.com/NuSkooler/enigma-bbs/issues/222). This may also resolve other issues, such as [Issue #365](https://github.com/NuSkooler/enigma-bbs/issues/365), and [Issue #320](https://github.com/NuSkooler/enigma-bbs/issues/320). Anyone that previously had terminal incompatibilities please re-check and let us know!
* Bumped up the minimum [Node.js](https://nodejs.org/en/) version to v14. This will allow more expressive Javascript programming syntax with ECMAScript 2020 to improve the development experience.
* **New Waiting For Caller (WFC)** support via the `wfc.js` module.
* Added new configuration options for `term.checkUtf8Encoding`, `term.checkAnsiHomePosition`, `term.cp437TermList`, and `term.utf8TermList`. More information on these options is available in [UPGRADE](UPGRADE.md).
* Many new system statistics available via the StatLog such as current and average load, memory, etc.
* Many new MCI codes: `MB`, `MF`, `LA`, `CL`, `UU`, `FT`, `DD`, `FB`, `DB`, `LC`, `LT`, `LD`, and more. See [MCI](./docs/art/mci.md).
* SyncTERM style font support detection.
* Added a system method to support setting the client encoding from menus, `@systemMethod:setClientEncoding`.
* Many additional backward-compatible bug fixes since the first release of 0.0.12-beta. See the [project repository](https://github.com/NuSkooler/enigma-bbs) for more information.
* Deprecated Gopher's `messageConferences` configuration key in favor of a easier to deal with `exposedConfAreas` allowing wildcards and exclusions. See [Gopher](./docs/servers/contentservers/gopher.md).
* NNTP write (aka POST) access support for authenticated users over TLS.
* [Advanced MCI formatting](./docs/art/mci.md#mci-formatting)!
* Additional options in the `abracadabra` module for launching doors. See [Local Doors](./docs/modding/local-doors.md)

## 0.0.12-beta
* The `master` branch has become mainline. What this means to users is `git pull` will always give you the latest and greatest. Make sure to read [Upgrading](./docs/admin/upgrading.md) and keep an eye on `WHATSNEW.md` (this file) and [UPGRADE](UPGRADE.md)! See also [ticket #276](https://github.com/NuSkooler/enigma-bbs/issues/276).
* Development now occurs against [Node.js 14 LTS](https://github.com/nodejs/node/blob/master/doc/changelogs/CHANGELOG_V14.md).
* The default configuration has been moved to [config_default.js](/core/config_default.js).
* A full configuration revamp has taken place. Configuration files such as `config.hjson`, `menu.hjson`, and `theme.hjson` can now utilize includes via the `includes` directive, reference 'self' sections using `@reference:` and import environment variables with `@environment`.
* An explicit prompt file previously specified by `general.promptFile` in `config.hjson` is no longer necessary. Instead, this now simply part of the `prompts` section in `menu.hjson`. The default setup still creates a separate prompt HJSON file, but it is `includes`ed in `menu.hjson`. With the removal of prompts the `PromptsChanged` event will no longer be fired.
* New `PV` ACS check for arbitrary user properties. See [ACS](./docs/configuration/acs.md) for details.
* The `message` arg used by `msg_list` has been deprecated. Please starting using `messageIndex` for this purpose. Support for `message` will be removed in the future.
* A number of new MCI codes (see [MCI](./docs/art/mci.md))
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

---
title: Menu Modules
description: "Write a menu module: the MenuModule lifecycle, menu methods, helpers and per-mod databases."
sidebar:
    order: 1
---
From initial connection to the screens and mods your users interact with, the entire experience is made up of menu entries — And all menu entries found within [menu.hjson](../configuration/menu-hjson.md) are backed by *Menu Modules*. For basic menus, a standard handler is implemented requiring no code. However, if you would like to create a menu that has custom handling, you will very likely be inheriting from from `MenuModule`. More on this below.

:::note
Remember that ENiGMA does not impose any stucture to your system! The "flow" of all `menu.hjson` entries is up to you!
:::

:::tip
If the `module` entry is not present in a `menu.hjson` entry, the system automatically uses [standard_menu.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/standard_menu.js). For the modules ENiGMA½ already ships with, see [Built-in Modules](../modules/index.md).
:::

## Creating a New Module
At the highest level, to create a new custom menu or mod, inherit from `MenuModule` and expose it via the `getModule` exported method:

```javascript
// my_fancy_module.js
exports.getModule = class MyFancyModule extends MenuModule {
  constructor(options) {
    super(options);
  }
};
```

Next, override the appropriate methods to add some functionality! Below is an example fragment overriding just `initSequence()`:

```javascript
initSequence() {
    async.series(
        [
            callback => {
                // call base method
                return this.beforeArt(callback);
            },
            callback => {
                // a private method to display a main "page"
                return this._displayMainPage(false, callback);
            },
        ],
        () => {
            this.finishedLoading();
        }
    );
}
```

:::tip
Remember that *all* menus within ENiGMA are created by inheriting from `MenuModule`. Take a look at existing examples such as [WFC](https://github.com/NuSkooler/enigma-bbs/blob/master/core/wfc.js), [NUA](https://github.com/NuSkooler/enigma-bbs/blob/master/core/nua.js), [MRC](https://github.com/NuSkooler/enigma-bbs/blob/master/core/mrc.js) and more!
:::

### ModuleInfo
To register your module with the system, include a `moduleInfo` declaration in your exports. The following members are available:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Short name of the module |
| `desc` | Yes | Long description of this module |
| `author` | Yes | Author(s) of module |
| `packageName` | No | Defines a reverse DNS style package name. Can be used in conjunction with the `getModDatabasePath()` call form [database.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/database.js) to interact with a database specific to your module (See example below) |

**Example**:

```javascript
exports.moduleInfo = {
  name: 'Super Dope Mod',
  desc: '...a super dope mod, duh.',
  author: 'You!',
  packageName: `com.myname.foo.super-dope-mod`,
};
```

### Per-Mod Databases
Custom mods often need their own data persistence. This can be achieved with `getModDatabasePath()` and your `moduleInfo`'s `packageName`.

**Example**:
```javascript
self.database = getTransactionDatabase(
    new sqlite3.Database(getModDatabasePath(moduleInfo), callback)
);
```

Given the `packageName` above, a database will be created at the following location:
```bash
$enigma-bbs/db/mods/com.myname.foo.super-dope-mod.sqlite3
```

### Menu Methods
Form handler methods specified by `@method:someName` in your `menu.hjson` entries map to those found in your module's `menuMethods` object. That is, `this.menuMethods` and have the following signature `(formData, extraArgs, cb)`. For example, consider the following `menu.hjson` fragment:

```hjson
actionKeys: [
  {
    keys: [ "a", "shift + a" ]
    action: @method:toggleAvailable
  }
]
```

We can handle this in our module as such:
```javascript
exports.getModule = class MyFancyModule extends MenuModule {
  constructor(options) {
    super(options);

    this.menuMethods = {
      toggleAvailable: (formData, extraArgs, cb) => {
        // ...do something fancy...
        return cb(null);
      }
    };
  }
}
```

## MenuModule Lifecycle
Methods shown with `()` in their name such as `enter()` are overridable when inheriting from `MenuModule`.

### Going to a menu
Every move between menus (`gotoMenu()`, `prevMenu()`, `nextMenu()`, a `@menu:` action, a reload) goes through the client's menu stack:

```mermaid
flowchart TD
    goto["menuStack.goto(name)"] --> load["load the menu and create its module"]
    load --> acs{"caller has access?"}
    acs -- no --> denied["callback with an error; the current menu stays"]
    acs -- yes --> save["previous menu: getSaveState(), then leave()"]
    save --> push["push the new menu; restoreSavedState() if state was saved"]
    push --> settle["settle anything left covering the old menu"]
    settle --> enter["enter()"]
    enter --> drain["displayQueuedInterruptions()"]
    drain --> init["initSequence()"]
```

* `leave()` of the menu being left runs before the new menu's `enter()`. The default marks the menu left (`hasLeftMenu()`), clears its menu timeouts (`setMenuTimeout()`) and detaches and destroys its forms (`detachViewControllers()`). It also runs when the caller disconnects, so it is a module's one chance to clean up (timers, temp files, node counts). If you override `leave()`, call `super.leave()`.
* `enter()` is called with no callback. The default shows any queued interruptions (`displayQueuedInterruptions(callback)`, skipped with `interrupt: never`), then calls `initSequence()`. If you override `enter()`, call `super.enter()`.
* If the caller was moved on while something covered the old menu (a sysop break-in or a time-up during a pause or an interrupt), what that cover held is settled first: its input capture and paused background drawing are dropped. A pending `waitForKeyPress()` is left alone: it gets the next key, which the new menu gets too, as it always did.

### initSequence()
The default `initSequence()`, which most modules keep:

```mermaid
flowchart TD
    before["beforeArt()"] --> mode{"pause: pageBreak?"}
    mode -- no --> art["menu art (if any)"]
    mode -- yes --> paged["menu art (if any), paged: a page-break prompt between screens, an end pause after the last"]
    art --> prompt["prompt art (if the menu has a prompt)"]
    paged --> prompt
    prompt --> mci["mciReady(mciData)"]
    mci --> pause{"pause set, and not pageBreak?"}
    pause -- yes --> pp["pausePrompt()"]
    pause -- no --> fin
    pp --> fin["finishedLoading()"]
    fin --> allow["realtime interrupts allowed"]
    allow --> next["autoNextMenu()"]
```

Each step after an async one (the art, the prompt art, `mciReady()`, the pause) first checks whether the menu has been left meanwhile (see [Leaving a menu](#leaving-a-menu)), and stops there if it has.

* `beforeArt(callback)` is called before any art is displayed. The default implementation clears the screen if requested by the menu's `config` block (`cls: true`). Baud rate emulation, if configured, is applied during the art display itself rather than here.
* `mciReady(mciData, callback)` is called when art is loaded and MCI codes are initialized. The default implementation of a custom `MenuModule` simply continues. See also [standardMCIReadyHandler](#standardmcireadyhandlermcidata-callback).
* With `pause: pageBreak`, the menu art is shown a screen at a time, with a page-break prompt between screens and an end-of-art pause after the last one (skipped if the caller quits); art that fits on one screen, or positions itself (native or RIP art), is shown without either. The pause step after `mciReady()` is then skipped. Any other `pause` value (`true`, `end`, a prompt name) gets one `pausePrompt()` below the art in that step.
* `finishedLoading()` does nothing in the base class. Right after it returns, the default `initSequence()` marks a menu with `interrupt: realtime` as interruptible. Calling `finishedLoading()` does not do that itself.
* `autoNextMenu()` moves on by itself only when the menu has `runtime.autoNext` (after `nextTimeout`, if set). The `nextTimeout` wait is a menu timeout: it is cancelled if the caller leaves the menu first.
* If a step fails, `initSequenceFailed(err)` goes back to the previous menu. Menu art that cannot be shown is not a failure; prompt art that cannot be shown is.

A module that overrides `initSequence()` (see [Creating a New Module](#creating-a-new-module)) runs only what it calls. It is not made interruptible by calling `finishedLoading()`, so on such a menu realtime interrupts stay queued. Nor does it get the left-menu checks: add `if (this.hasLeftMenu()) return;` after its own async steps if it wants them.

### Leaving a menu
The caller can leave a menu while it is still loading: a hotkey, a sysop break-in, a time-up or a disconnect while its art is being drawn at a baud rate, or while it reads the database. `leave()` then runs before the menu's own callbacks have finished, and anything they draw or build next would land on the next menu's screen.

The default `initSequence()`:

```mermaid
sequenceDiagram
    participant S as menu stack
    participant M as menu
    participant A as art / async work
    M->>A: displayAsset(...)
    S->>M: leave(): left, menu timeouts cleared, forms destroyed
    S->>S: next menu: enter()
    A-->>M: art done
    M->>M: hasLeftMenu() is true: stop (debug log)
    Note over M: no mciReady(), no forms or tickers,<br/>no pause, no autoNextMenu()
```

A prep helper (`prepViewControllerWithArt()` here) still calls back:

```mermaid
sequenceDiagram
    participant S as menu stack
    participant M as menu
    participant A as art
    M->>A: prepViewControllerWithArt(name, ...)
    S->>M: leave(): left, menu timeouts cleared, forms destroyed
    A-->>M: art done
    M->>M: form built, then torn down<br/>(keys detached, views destroyed, timers stopped)
    M-->>M: callback(err, viewController, true), as before
```

* `hasLeftMenu()` is true once `leave()` has run. Check it after your own async steps before drawing, building forms or navigating.
* `leave()` **destroys** the menu's forms, every one still in `viewControllers` (see [Form states](../art/views/views.md#form-states)): a destroyed form cannot be attached again, so a late `setFocus(true)`, `activate()` or `switchFocus()` on one does nothing, and keys stay with the menu now on screen. A reload, or coming back to the menu, makes a new instance with new forms. `removeViewController(name)` is unchanged: it detaches the form and forgets it, without destroying it.
* The default `initSequence()` checks it after each async step, as above. A form built by an `mciReady()` that finishes after `leave()` is torn down.
* `prepViewController()`, `prepViewControllerWithArt()` and `displayArtAndPrepViewController()` call back as they always have, with the same arguments, so your callback's cleanup still runs. But a form they build for a menu that has been left is torn down before they call back (its keys detached, its views destroyed, their timers stopped), and one that already existed is not refocused. Check `hasLeftMenu()` in the callback before drawing, refocusing a form or navigating.
* `setMenuTimeout(fn, ms)` is a `setTimeout()` that belongs to the menu: `leave()` clears it, so `fn` never runs for a menu the caller has left. It returns a handle for `clearMenuTimeout(handle)`. `autoNextMenu()` (`nextTimeout`) and `prevMenuOnTimeout(ms, cb)` use it. Prefer it to a bare `setTimeout()` for anything that draws or moves the caller on.

### Realtime interrupts
On a menu with `interrupt: realtime`, an interrupt that arrives (a node message, a page, an achievement) once the default `initSequence()` has finished loading (after `finishedLoading()`) is shown at once. Before then, on a menu that overrides `initSequence()`, or on a menu set to `queued`, it is queued for the next menu's `enter()`.

```mermaid
sequenceDiagram
    participant Q as interrupt queue
    participant M as current menu
    participant C as cover
    Q->>M: attemptInterruptNow(item)
    alt not allowed now
        M-->>Q: queue it for the next menu
    else realtime and allowed
        M->>C: begin: input captured, background drawing paused
        C->>C: clear screen, interrupt art or text, pausePrompt()
        C->>M: key pressed: end of cover
        M->>M: reload(): leave(), then menuStack.goto(same menu)
        M->>M: enter() -> initSequence()
    end
```

While the interrupt is up, the menu's forms stay attached but get no keys, and its tickers and status bars do not draw over it. A ticker in the pause prompt still animates. The key that dismisses the interrupt does not reach the menu. A module can override `attemptInterruptNow(interruptItem, cb)` to hold interrupts back, calling `cb(null, false)` to leave the item queued.

### Covers and input capture
Sometimes a module shows something over its own screen and then gives the screen back: a help page, a message, a confirmation. Its forms are still attached underneath. Pick by what the screen does:

* **Over the whole screen, then back** (a help page): use `this.coverScreen(options, fn, cb)`. While `fn(done)` runs, the forms get no keys, including the key that ends the cover, and their tickers and status bars do not draw. Views created inside `fn` (a form you build for the help page, a ticker in a pause prompt) draw as usual. Pass `scope: { menu: this }` in `options` to also pause any form of this menu built while the cover is up, such as one whose art finishes loading under it (interrupts do this). A `client.waitForKeyPress()` inside it still gets its key: a wait is a plain listener, not a capture. Call `done(err)` when finished; `options.restore(cb)` then repaints your screen, before input and drawing are given back. Views that missed a draw get one redraw unless `redrawMissed: false`.

  ```javascript
  displayHelp(cb) {
      this.coverScreen(
          { restore: done => this.redrawMyScreen(done) },
          done => {
              this.displayAsset(this.menuConfig.config.art.help, { clearScreen: true }, () => {
                  this.client.waitForKeyPress(() => done(null));
              });
          },
          cb
      );
  }
  ```

  The same helper is `coverScreen(client, options, fn, cb)` in `core/screen_cover.js`, for code that is not a menu module.

* **Over one form** (a prompt or another form drawn over part of it): `vc.cover()`, then `vc.uncover()` and `vc.activate()`. See [Form states](../art/views/views.md#form-states).
* **Your own key handling for a while,** with nothing covered (a "press Y or N" read by code, a key-driven mini screen): use `client.captureInput(handler, options)` and `client.releaseInput(token)`. The forms get no keys while you hold it. See [Input capture](../art/views/views.md#input-capture).
* **A pause on the same screen,** drawn under the menu's art: `pausePrompt()` (or `client.waitForKeyPress()`) on its own. The tickers and status bars on screen keep animating, and the key that ends it also reaches the forms, as it always has (so does the key for a menu's own `pause: true`). If it must not, show the pause inside `coverScreen()`.

A pause shown with `clearScreen` (`displayThemedPause()`, or `displayThemedPrompt()` with both `clearScreen` and `pause`) also pauses the background drawing of the screen under it while it waits for its key. It does not capture input: its key reaches the forms too, as before. A prompt that clears the screen without pausing (an `ET` prompt the module then reads) pauses nothing: the module owns the screen from there, as before.

If the menu changes while a cover is up (a sysop break-in, a time-up, an idle logoff), the cover is abandoned: its `restore` and callback do not run, since the menu they belong to is gone, and the key that would have ended it reaches the new menu as well.

## MenuModule Helper Methods
Many helper methods exist and are available to code inheriting from `MenuModule`. Below are some examples. Poke around at [menu_module.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/menu_module.js) to discover more!

### Views & View Controller
#### `displayAsset(name | Buffer, options, callback)`:
Display an asset by `name` or by supplying an `Buffer`.
`options` is an optional Object with any of the following properties:
* `clearScreen` (Boolean): Should the screen be cleared first?
* `encoding` (String): Encoding of `Buffer` if used. Defaults to `cp437`.
* `font` (String): SyncTERM style font to use.
* `trailingLF` (Boolean): Should a trailing LF be allowed?
* `startRow` (Number): Row in which to start drawing at

#### `prepViewController(name, formId, mciMap, callback)`:
Prepares the menu's View Controller for a form of `name` and `formId` using the supplied `mciMap`. `callback` has the following siguature: `(err, viewController, created)` where `created` is `true` if a new View Controller was made.

#### `displayArtAndPrepViewController(name, formId, options, callback)`:
Displays the art `name` from the menu's `config.art` block, then prepares the View Controller `name` for form `formId` over it (or refocuses it, if it already exists). `options` may hold `clearScreen`, `noInput`, `viewOffsets` and `artDataPrep(name, artData, viewController)`. `callback` has the signature `(err)`. To know whether the View Controller was made, check `this.viewControllers[name]` before the call.

Once the menu has been left, these helpers (and `prepViewControllerWithArt()`) still call back, but with the form torn down: see [Leaving a menu](#leaving-a-menu).

* `prepViewControllerWithArt()`
* `setViewText()`
* `getView()`
* `updateCustomViewTextsWithFilter()`
* `refreshPredefinedMciViewsByCode()`

### Validation
* `validateMCIByViewIds()`
* `validateConfigFields()`

### Date/Time Helpers
The following methods take a single input to specify style, defaulting to `short`. If your menu or theme `config` block specifies a cooresponding value such as `dateFormat` or `dateTimeFormat`, that value will be used, else standard fallbacks apply:
* `getDateFormat()`
* `getTimeFormat()`
* `getDateTimeFormat()`

### Misc
#### `promptForInput({ formName, formId, promptName, prevFormName, position }, options, callback)`:
Shows the prompt `promptName` at `position` and loads form `formId` over it into View Controller `formName`. With `prevFormName`, that form is covered while the prompt is up (no keys, no background drawing; its views and their timers are kept) and activated again when the prompt is submitted. Its view listeners are removed when the prompt opens, as before, so add them again in the prompt's actions. `options` may hold `submitNotify`, `clearAtSubmit` and `clearWidth`. Before 0.6.2-beta the previous form was torn down (`setFocus(false)`), so a ticker in it stopped for good.


#### `standardMCIReadyHandler(mciData, callback)`:
This is a standard and commonly used `mciReady()` implementation:

```javascript
mciReady(mciData, cb) {
  return this.standardMCIReadyHandler(mciData, cb);
}
```

Where `mciData` is a Object mapping [MCI codes](../art/mci.md) such as `TL2` to their properties:
* `SGR`: Graphics rendition
* `focusSGR` (Only present if art contained both, ie: `TL2^[0;mTL2`)
* `position` (Array of Number): Position in [Row, Column] order
* `args` (Array): Any arguments to the MCI code
* `code` (String): The code itself, such as `TL`
* `id` (Number): The MCI code's ID such as `1`

:::note
Search the code for the above methods to see how they are used in the base system!
:::


### Default custom info formats
Art places custom views `%TL10`, `%TL11`... (up to 99) that a module fills with `updateCustomViewTextsWithFilter(formName, startId, fmtObj)`. Their formats come from the menu's `config` as `${formName}InfoFormat${id}`, e.g. `mainInfoFormat10`. To make a mod work with no operator config, override `getDefaultCustomInfoFormats(formName)` and return the defaults keyed by view ID:

```javascript
getDefaultCustomInfoFormats(formName) {
    return 'main' === formName ? { 10: '{msgCount} new', 11: '{userName}' } : {};
}
```

* An operator's `config` (or theme) entry always wins over a default.
* Setting an entry to an empty string, `null` or `false` (`mainInfoFormat10: ""`) hides that view even though the module has a default for it. For a module without a default, either is the same as not setting it.
* Never write defaults into `this.menuConfig.config`: it is the shared, cached theme object. `getCustomInfoFormat(formName, id)` is the lookup, and `getCustomViewsWithFilter()` (including its `filter` option) and `updateCustomViewTextsWithFilter()` both use it.

## Custom Mods
Most mods will also derive from `MenuModule`. Some things to be aware of:
* Custom mods that bring in their own dependencies must also include their own `package.json` and other Node requirements
* Be sure to use `packageName` and `getModDatabasePath()` for any (database) peristence needs.
* Custom mods in `mods/the_mod_name/` and the `MenuModule` entry point must be within a file of the same name: `mods/the_mod_name/the_mod_name.js`
* To import ENiGMA modules `require()` from `../../core/`

### Shipping art with a mod
A mod kept in its own folder can ship its art in an `art` folder beside its code, and its menus name that art by plain name:

```
mods/the_mod_name/the_mod_name.js
mods/the_mod_name/art/MYMOD.ANS
mods/the_mod_name/art/MYMODHLP.ANS
```

```hjson
myModMenu: {
    module: @userModule:the_mod_name
    art: MYMOD
    config: {
        art: {
            help: MYMODHLP
        }
    }
}
```

For a menu whose `module` is that mod, art is looked for in the user's theme, then the default theme, then `mods/the_mod_name/art/`, then `art/general` (see [General Art Information](../art/general.md#art-spec)). So the operator needs to copy nothing, the art updates with the mod, and an operator who wants a different look drops a file of the same name (`MYMOD.ANS`) into their theme, as for any other art. Everything that works in a theme folder works in the mod's: random selection (`MYMOD1.ANS`, `MYMOD2.ANS`, ...), UTF-8 variants, native `.seq` / `.ata` art and `.rip` art for RIP callers. The folder is yours and the operator's, as trusted as a theme.

Some things to know:
* Only plain names are looked for there: an art name holding a path (`art/foo/MYMOD.ANS`) means exactly that file, as before.
* Only a mod in its own folder has one. A single file mod (`mods/the_mod_name.js`) shares `mods/` with every other mod and has no art folder: its art goes in a theme or `art/general`.
* Art the menu shows through `MenuModule` gets the fallback: the menu's `art` and its `prompt`, `displayAsset()`, `prepViewControllerWithArt()` and `displayArtAndPrepViewController()` (`config.art.<name>`), paged art, and prompts shown with `promptForInput()`. Pause prompts are shared system screens and do not, even one a menu names with `pausePrompt`: for its own pause art, a mod's README should have the operator add a prompt with that art in their theme (or `art/general`) and set the menu's `pausePrompt` to it (see [Pause Prompts](../art/pause-prompts.md)). Code that calls `core/theme.js` directly can pass `modArtPath: this.modArtPath` in its options to get the same.
* Pick names that are unlikely to clash with other art: a theme's file of the same name always wins, and the mod's file wins over one in `art/general`.
* A missing `art` folder is fine: the lookup moves on to `art/general`.

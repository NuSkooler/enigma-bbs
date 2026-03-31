# Developer Guide

This document covers internal architecture and conventions for contributors working on ENiGMA½ core systems. It supplements [CONTRIBUTING.md](CONTRIBUTING.md), which covers style and process.

## Architecture Overview

ENiGMA½ is a multi-client BBS server. Each connected user gets a dedicated `client` object that holds their terminal state, session, and current menu module. All user-facing logic runs through **menu modules** driven by a `menu.hjson` configuration file.

Key directories:

| Path | Purpose |
|------|---------|
| `core/` | Server engine, view system, menu/session management |
| `mods/` | **User-supplied** mods — ENiGMA ships nothing here; sysops drop local modules in |
| `art/general/` | General art files — theme-agnostic or used as fallback across themes |
| `art/themes/<name>/` | Per-theme art files; ENiGMA ships with the `luciano_blocktronics` default theme |
| `misc/menu_templates/` | Canonical `menu.hjson` templates — `oputil` uses these for initial deployment; sysops then modify their own copies |
| `docs/` | End-user and sysop documentation |
| `test/` | Mocha test suite |

## Art & Theme System

> :construction: Full documentation lives in `docs/_docs/art/`. This section is a quick map for contributors.

Art files are ANSI or UTF-8 files with SAUCE metadata stored under `art/themes/<theme-name>/`. They contain **MCI codes** (`%SB1`, `%TL1`, `%VM1`, etc.) which are placeholders for interactive views.

The pipeline from art to live view:
1. `MenuModule.displayAsset()` renders the art file and runs the ANSI parser
2. The parser emits MCI positions (screen row/col for each `%XX#` code)
3. `MCIViewFactory.createFromMCI()` instantiates the correct view class
4. `ViewController.loadFromMenuConfig()` applies properties from `menu.hjson` via `view.setPropertyValue()`

**Theme overrides**: `theme.hjson` can override any MCI property using the same config path as `menu.hjson`.

**Double-MCI convention**: art files encode normal and focus SGR for a view by placing the MCI code twice (`%TL1%TL1`) — first occurrence captures normal SGR, second captures focus SGR.

**Templates**: `misc/menu_templates/*.in.hjson` are the canonical defaults used by `oputil` when a sysop first deploys their system. After that, sysops own their copies and modify them freely. When adding or changing MCI config, update the template *and* any local dev config.

## Menu Modules

A menu module is a class that extends `MenuModule` (or a mixin thereof), exported as `getModule`:

```js
exports.moduleInfo = { name: 'My Module', desc: '...', author: '...' };

exports.getModule = class MyModule extends MenuModule {
    constructor(options) {
        super(options);
        this.menuMethods = {
            doAction: (formData, extraArgs, cb) => {
                // handle form submit
                return cb(null);
            },
        };
    }

    initSequence() {
        async.series(
            [
                callback => this.beforeArt(callback),
                callback => this.displayViewScreen(false, callback),
            ],
            err => { if (err) { /* ... */ } }
        );
    }
};
```

Module-specific config comes from the `config:` block in the menu entry via `this.menuConfig.config`.

## View System

All view properties flow through `view.setPropertyValue(propName, value)` — never set instance variables directly from outside the view. The factory creates views with minimal options; `ViewController` applies the full config after creation.

Views have `acceptsFocus` and `acceptsInput` (both `false` by default). Any view that owns a timer must implement `destroy()` to clear it — `ViewController.detachClientEvents()` calls `destroy()` on all views.

See `docs/_docs/art/views/` for per-view documentation.

## Configuration

* System config: `Config.get()` — the singleton loaded from `config.hjson`
* Module config: `this.menuConfig.config` — the `config:` block of the current menu entry
* Safe access idiom: `_.get(this.menuConfig.config, 'someKey', defaultValue)`

Config files use **hjson** (comments, unquoted keys, trailing commas are all valid).

## Testing

```bash
npm test          # run full suite
npm test -- --grep "pattern"   # run matching tests
```

* Framework: Mocha + Node `assert` (`assert.strictEqual`, not `expect`/`should`)
* `test/setup.js` patches `Config.get` so view constructors work in isolation — always included via `--require test/setup.js`
* Async tests: wrap callback APIs in a small Promise helper, then use `async/await` in the test body
* Tests for a module live in `test/<module-name>.test.js`

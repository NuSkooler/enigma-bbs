# Contributing

## Getting Started

ENiGMA½ requires Node.js (see `.node-version` / `.mise.toml` for the version in use). Install dependencies with:

```bash
npm install
```

Run the test suite before submitting any PR:

```bash
npm test
```

## Style & Formatting

* [Prettier](https://prettier.io) is used for formatting. Run it before committing or configure your editor to format on save. See [Prettier install](https://prettier.io/docs/en/install.html).
* Use modern JavaScript — ES6 classes, arrow functions, destructuring, template literals.
* `const` by default; `let` when reassignment is needed. Never `var`.
* UNIX line feeds, UTF-8 without BOM, tabs set to 4 spaces.
* Do not include the `.js` suffix in `require()` calls.

### Arrow Functions

Prefer arrow functions for callbacks:

```js
// Good
someApi(foo, bar, (err, result) => {
    // ...
});

// Bad
someApi(foo, bar, function callback(err, result) {
    // ...
});
```

### Imports

```js
// Good
const foo = require('foo');

// Bad
const foo = require('foo.js');
```

## Async

All production code uses the [`async`](https://caolan.github.io/async/) library for flow control. **Do not introduce Promises or `async`/`await` in production code** — keep the existing pattern consistent.

```js
async.waterfall(
    [
        callback => {
            doSomething((err, result) => callback(err, result));
        },
        (result, callback) => {
            doSomethingElse(result, err => callback(err));
        },
    ],
    err => {
        if (err) {
            return log.warn({ err }, 'Operation failed');
        }
    }
);
```

> Note: `async`/`await` is fine in **test code** — just not in `core/` or `mods/`.

## Error Handling & Logging

Use the error factories from `core/enig_error.js` rather than plain `new Error()`:

```js
const { Errors } = require('./enig_error.js');
return cb(Errors.DoesNotExist('Message not found'));
```

Log via the client logger with a structured context object as the first argument:

```js
this.client.log.warn({ err, filePath }, 'Failed to read file');
this.client.log.info({ userId: user.userId }, 'User authenticated');
```

## Constants

Avoid inline magic numbers. Declare named constants at the top of the module:

```js
const FormIds = { main: 0, help: 1 };
const MciViewIds = { messageList: 1, infoPanel: 2 };
```

## Comments

* Use `:TODO:` for planned work, `:FIXME:` for known bugs.
* Precede non-obvious logic with a short explanatory comment.
* Use `//  ── Section Name ──────` dividers in longer files to group related methods.

## Pull Requests

* One concern per PR — keep scope focused.
* Reference any related GitHub issue in the PR description.
* All existing tests must pass; add tests for new behaviour where practical.
* Update `WHATSNEW.md` for user-visible changes and `UPGRADE.md` for breaking changes.

## Further Reading

For deeper background on how the system works — the art/theme pipeline, menu module pattern, view system, and configuration — see [DEV.md](DEV.md).

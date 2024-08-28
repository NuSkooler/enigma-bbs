# Contributing

## Style & Formatting
* In general, [Prettier](https://prettier.io) is used. See the [Prettier installation and basic instructions](https://prettier.io/docs/en/install.html) for more information.
* Though you'll see a lot of older style callback code, please utilize modern JavaScript. ES6 classes, [Arrow Functions](#arrow-functions), and builtins.
* There is almost never a reason to use `var`. Prefer `const` where you can and and `let` otherwise.
* Save with UNIX line feeds, UTF-8 without BOM, and tabs set to 4 spaces.
* Do not include the `.js` suffix when [Importing (require)](#import-require)

### Arrow Functions
Prefer anonymous arrow functions with access to `this` for callbacks.
```js
// Good!
someApi(foo, bar, (err, result) => {
    // ...
});

// Bad :(
someApi(foo, bar, function callback(err, result) {
    // ...
});
```

### Import (require)
```javascript
// Good!
const foo = require('foo');

// Bad :(
const foo = require('foo.js');
```
---
layout: page
title: Event Scheduler
---
## Event Scheduler
The ENiGMA½ scheduler allows system operators to configure arbitrary events that can can fire based on date and/or time, or by watching for changes in a file. Events can kick off internal handlers, custom modules, or binaries & scripts.

## Scheduling Events
To create a scheduled event, create a new configuration block in `config.hjson` under `eventScheduler.events`.

Events can have the following members:

| Item | Required | Description |
|------|----------|-------------|
| `schedule` | :+1: | A [Later style](https://bunkat.github.io/later/parsers.html#text) parsable schedule string such as `at 4:00 am`, or `every 24 hours`. Can also be (or contain) an `@watch` clause. See **Schedules** below for details. |
| `action` | :+1: | Action to perform when the schedule is triggered. May be an `@method` or `@execute` spec. See **Actions** below. |
| `args` | :-1: | An array of arguments to pass along to the method or binary specified in `action`. |

### Schedules
As mentioned above, `schedule` may contain a [Later style](https://bunkat.github.io/later/parsers.html#text) parsable schedule string and/or an `@watch` clause.

`schedule` examples:
* `every 2 hours`
* `on the last day of the week`
* `after 12th hour`

An `@watch` clause monitors a specified file for changes and takes the following form: `@watch:<path>` where `<path>` is a fully qualified path.

> :bulb: If you would like to have a schedule **and** watch a file for changes, place the `@watch` clause second and separated with the word `or`. For example: `every 24 hours or @watch:/path/to/somefile.txt`.

### Actions
Events can kick off actions by calling a method (function) provided by the system or custom module in addition to executing arbritary binaries or scripts.

#### Methods
An action with a `@method` can take the following forms:

* `@method:/full/path/to/module.js:methodName`: Executes `methodName` at `/full/path/to/module.js`.
* `@method:rel/path/to/module.js:methodName`: Executes `methodName` using the *relative* path `rel/path/to/module.js`. Paths for `@method` are relative to the ENiGMA½ installation directory.

Methods are passed any supplied `args` in the order they are provided.

##### Method Signature
To create your own method, simply `export` a method with the following signature: `(args, callback)`. Methods are executed asynchronously.

Example:
```javascript
// my_custom_mod.js
exports.myCustomMethod = (args, cb) => {
    console.log(`Hello, ${args[0]}!`);
    return cb(null);
}
```

#### Executables
When using the `@execute` action, a binary or script can be executed. A full path or just the binary name is acceptable. If using the form without a path, the binary much be in ENiGMA½'s `PATH`.

Examples:
* `@execute:/usr/bin/foo`
* `@execute:foo`

Just like with methods, any supplied `args` will be passed along.

## Example Entries

Post a message to supplied networks every Monday night using the message post mod (see modding):
```hjson
eventScheduler: {
    events: {
        enigmaAdToNetworks: {
            schedule: at 10:35 pm on Mon
            action: @method:mods/message_post_evt/message_post_evt.js:messagePostEvent
            args: [
                "fsx_bot"
                "/home/enigma-bbs/ad.asc"
            ]
        }
    }
}
```
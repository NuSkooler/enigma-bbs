---
title: Event Scheduler
description: "Schedule recurring events by time or by watching a file, and run methods or external commands."
sidebar:
    order: 14
---
The ENiGMA½ scheduler allows system operators to configure arbitrary events that can can fire based on date and/or time, or by watching for changes in a file. Events can kick off internal handlers, custom modules, or binaries & scripts.

## Scheduling Events
To create a scheduled event, create a new configuration block in `config.hjson` under `eventScheduler.events`.

Events can have the following members:

| Item | Required | Description |
|------|----------|-------------|
| `action` | Yes | Action to perform when the event runs. May be an `@method` or `@execute` spec. See **Actions** below. |
| `schedule` | No | A [Later style](https://bunkat.github.io/later/parsers.html#text) parsable schedule string such as `at 4:00 am`, or `every 24 hours`. Can also be (or contain) an `@watch` clause. See **Schedules** below for details. Without one, the event is a **manual-only task**: see below. |
| `args` | No | An array of arguments to pass along to the method or binary specified in `action`. |
| `desc` | No | A display name for the event, for example in a task list. Defaults to the event's name. |
| `confirm` | No | `true` asks the operator to confirm before running the event by hand. The scheduler itself does nothing with it; it is for whatever offers the event to an operator, such as the [WFC's task screen](../modules/wfc.md#tasks). |
| `manual` | No | Default `true`. `false` hides the event from the task list and refuses to run it by hand; it still runs on its schedule. |
| `enabled` | No | Default `true`. `false` ignores the entry entirely: it is neither scheduled nor listed. This is how to switch off one of the built-in events. |
| `timeout` | No | Milliseconds a run may take before it is overdue. An overdue `@execute` process is killed, and its run fails with `timed out`. A `@method` cannot be stopped, so an overdue one keeps running and its event stays blocked until it finishes or an operator stops it; see **Running Events and Their Results**. Unset or `0`: no limit. |

`oputil.js config validate` knows these members and warns about any other, so a misspelled `schedule` (which would otherwise quietly make the event manual-only) is caught.

To switch off a built-in event, or change one of its members, name it in your `config.hjson`. Your entry is merged over the built-in one:

```hjson
eventScheduler: {
    events: {
        //  never trim message areas automatically
        trimMessageAreas: {
            enabled: false
        }
        //  back up the databases every night, keeping a week of backups
        backupDatabases: {
            schedule: at 4:00 am
            args: [ "7" ]
        }
    }
}
```

### Schedules
As mentioned above, `schedule` may contain a [Later style](https://bunkat.github.io/later/parsers.html#text) parsable schedule string and/or an `@watch` clause.

`schedule` examples:
* `every 2 hours`
* `on the last day of the week`
* `after 12th hour`

An `@watch` clause monitors a specified file for changes and takes the following form: `@watch:<path>` where `<path>` is a fully qualified path.

:::tip
If you would like to have a schedule **and** watch a file for changes, place the `@watch` clause second and separated with the word `or`. For example: `every 24 hours or @watch:/path/to/somefile.txt`.
:::

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

## Manual-only Tasks
An event with an `action` and no `schedule` is never run on its own. It is listed with the other events and can be run on demand, for example from the [WFC's task screen](../modules/wfc.md#tasks). At startup ENiGMA½ logs one line naming every manual-only event, so an event whose `schedule` was left out by mistake stays visible:

```
Manual-only scheduled events (no schedule, run on demand): optimizeDatabases, checkpointDatabases, backupDatabases, tossInboundNow
```

A `schedule` that is there but cannot be parsed is still an error: the event is logged as an `Invalid scheduled event entry` and dropped, as before.

## Built-in Events
ENiGMA½ ships with these events. Each can be switched off with `enabled: false`, given a `schedule`, or otherwise changed as above.

| Event | Schedule | Description |
|-------|----------|-------------|
| `dailyMaintenance` | at 11:59pm | Resets today's counters (logins, posts, new users). Asks for confirmation when run by hand. |
| `trimMessageAreas` | every 24 hours | Deletes messages beyond each area's age and count limits. Asks for confirmation when run by hand. |
| `nntpMaintenance` | every 12 hours | NNTP server housekeeping. |
| `updateFileAreaStats` | every 1 hours | Recounts the file base statistics. |
| `forgotPasswordMaintenance` | every 24 hours | Removes expired password reset tokens. |
| `twoFactorRegisterTokenMaintenance` | every 24 hours | Removes expired 2FA registration tokens. |
| `activityPubActorCacheMaintenance` | every 24 hours | Removes old ActivityPub actor records. |
| `activityPubSharedInboxMaintenance` | every 24 hours | Trims the ActivityPub shared inbox. |
| `optimizeDatabases` | manual-only | Runs SQLite's `PRAGMA optimize` on each database. Quick. |
| `checkpointDatabases` | manual-only | Folds each database's write-ahead log (`*.sqlite3-wal`) back into the database and truncates it. If a reader is busy the checkpoint cannot finish; this is logged and the next checkpoint catches up. |
| `backupDatabases` | manual-only | Copies the core databases (`system`, `user`, `message`, `file`, `activitypub`) into a new directory, `backup/YYYYMMDD-HHmmssZ/` under `paths.db` (named in UTC, so the names sort by time), while the BBS keeps running, then deletes all but the newest backups. `args: [ "N" ]` sets how many to keep (default 3), counting the new one, which is never deleted. Old backups are deleted only after the new one is complete, so allow disk space for one more set than you keep. A backup is written to a `.partial` directory first and renamed when complete, so a directory without that suffix is always a full set. Databases kept by mods are not included. |
| `tossInboundNow` | manual-only | Asks the FTN BSO scanner/tosser to import and toss its inbound directories now. It finishes as soon as the request is made (the toss is logged by the tosser), and fails if the FTN BSO scanner/tosser is not running. |

:::note
There is deliberately no `VACUUM` task: SQLite rebuilds the whole database during a VACUUM and the BBS would be frozen until it finished.
:::

## Running Events and Their Results
An event may run on its schedule, when its `@watch` file changes, or by hand. Every run goes through the same path:

* **One run at a time.** An event that is still running is not started again. A scheduled run skipped for that reason is logged at `info`, so an event that hangs does not just quietly stop happening; one skipped because its watch file changed again, or a request to run it by hand, is logged at `debug` (a WFC will tell the operator directly).
* **Logging.** The start of each run is logged at `info` with its reason (`Schedule`, `Watch file: ...`, or the reason given for a manual run, along with who ran it), and its end at `info` with how long it took. A failure is logged at `warn`.
* **Timeouts.** A run that goes past the event's `timeout` is *overdue*: this is logged at `warn` and the `TaskOverdue` system event is emitted. What happens next depends on the action:
  * an `@execute` process is killed (hung up on, then `SIGKILL` 5 seconds later if it is still there), and the run fails with `timed out` once it exits;
  * a `@method` cannot be stopped, so it keeps running, and the event stays blocked (not started again, by hand or on schedule) and shown as overdue until the method finishes. Its run is then recorded as usual, marked as having overrun.
* **Stopping a run.** An operator can stop a running event, overdue or not (for example from the WFC). An `@execute` process is killed and the run fails with `stopped by <operator>` when it exits. A `@method` is *abandoned*: its run is finished at once, failed with `abandoned by <operator>`, and the event can run again. JavaScript gives no way to stop a function, so an abandoned method may well still be working in the background, and whatever it reports later is ignored. Abandon only a run you believe is stuck, and bear in mind a second run may overlap the first.
* **Last run.** The result of each event's most recent run is kept: when it started and ended, how long it took, whether it succeeded and the error if not, why it ran and who ran it, whether it overran its timeout and who stopped it, and for `@execute` the exit code and the last 20 lines of output (with terminal escape codes removed). It is saved as the system stat `task_last_run_<event name>`, so it survives a restart. A count of runs since startup is kept as well.

Three system events follow each run, for modules that want them: `TaskStarted` with `{ name, desc, reason, byUser }`; `TaskOverdue` with `{ name, desc, reason, byUser, timeoutMs, startedAt }` when a run passes its timeout; and `TaskFinished` with `{ name, desc, reason, byUser, ok, error, durationMs, overdue }`.

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
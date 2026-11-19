---
title: File Scanning
description: "Scan uploads and TIC imports for viruses before ENiGMA½ looks inside them, with any command-line scanner or one from a mod."
sidebar:
    order: 4
---
ENiGMA½ can run every untrusted file through one or more **scanners** before it does anything else with it: before it opens an archive, reads a `FILE_ID.DIZ`, or runs an info tool on it. A file a scanner rejects never reaches the file base. It is quarantined (or deleted, if you prefer), and the operators get a private message about it.

Files are scanned when they come in:

| Source | When | `sources` name |
|--------|------|----------------|
| Telnet/SSH uploads | After the transfer, before the file details page | `upload` |
| [REST API](../servers/contentservers/rest-api.md) uploads | Before the file is moved into the area's storage | `web` |
| [TIC](tic-support.md) imports | Before the file is stored, **and** for passthrough echoes before it is relayed to downlinks | `tic` |
| `oputil fb scan` | Only with `--virus-scan` | `oputil` |

Files the sysop or the system makes (a TIC hatch, exports, offline mail packets) are not scanned.

Scanning is off until you turn it on. ENiGMA½ ships one scanner, `command`, which runs a program per file and looks at its exit code, the way BBS upload testers always have. Other scanners, such as a ClamAV daemon client, come from [mods](#writing-a-scanner). A first-party mod with ClamAV (`clamd`) and VirusTotal hash lookup scanners is planned.

## Configuration
File scanning lives under `fileBase.scanning` in `config.hjson`:

```hjson
fileBase: {
    scanning: {
        enabled: true

        //  quarantine | delete
        failAction: quarantine

        //  relative paths are relative to fileBase.areaStoragePrefix
        quarantinePath: .quarantine

        //  who gets the private mail about a rejected file
        notifyUserIds: [ 1 ]

        scanners: [
            {
                scanner: command
                cmd: clamscan
                args: [
                    "--no-summary"
                    "{filePath}"
                ]
                signatureRegex: "^.*: (.+) FOUND$"
            }
        ]
    }
}
```

| Item | Default | Description |
|------|---------|-------------|
| `enabled` | `false` | Turns file scanning on |
| `failAction` | `quarantine` | What happens to a file a scanner finds something in: `quarantine` or `delete`. A [held](#when-a-scanner-fails) file is always quarantined |
| `quarantinePath` | `.quarantine` | Where quarantined files go. Relative to `fileBase.areaStoragePrefix`. The default is a dot directory, which `oputil fb scan` never picks up, even for a `/*` storage tag over the whole prefix |
| `notifyUserIds` | `[ 1 ]` | User IDs that get a private message for each batch of rejected files |
| `defangExtensions` | `exe`, `com`, `bat`, `cmd`, `scr`, `pif`, `ps1`, `vbs`, `js`, `sh` | Extensions renamed in quarantine, DOS style: `FOO.EXE` becomes `FOO.EX_` |
| `scanners` | `[]` | The scanners to run, in order; see below |

### Scanner entries
Each entry in `scanners` names a registered scanner and says when it runs. The entries that match a file run in order:

* The first scanner that finds something rejects the file, and no later scanner runs.
* A scanner that fails or times out holds the file, unless its entry says `onError: accept`.
* Otherwise the file is accepted. **That includes a file every scanner `skipped`**: a hash lookup that has never seen the file, say, or a scanner that does not handle its type or size. `skipped` means "no opinion", not "clean", but it does not stop the file. If you rely on such a scanner alone, unknown files get in.

Some configurations look as if they scan but let everything through. ENiGMA½ warns about these in the log at startup, and `oputil fb scan --virus-scan` prints the same warnings:

* scanning enabled with an empty `scanners` list;
* an entry with an empty `fileTypes` list (`[]`) or no known `sources`, which never runs;
* an entry naming a scanner that no mod registered, which holds every file it sees (or, with `onError: accept`, accepts them).

| Item | Default | Description |
|------|---------|-------------|
| `scanner` | (required) | The scanner's registered name: `command`, or one a mod provides |
| `enabled` | `true` | Set to `false` to switch an entry off without removing it |
| `sources` | all | Which of `upload`, `web`, `tic`, `oputil` and `rescan` this entry scans |
| `fileTypes` | `"*"` | `"*"`, or a list of extensions, e.g. `[ "zip", "exe" ]`, matched against the file's real name. Trailing dots and spaces are ignored, so `FOO.EXE.` counts as `exe`, as Windows would run it. An empty list matches nothing |
| `timeout` | `60000` | Milliseconds before the scanner is given up on, which counts as a failure |
| `onError` | `hold` | `hold` (quarantine the file) or `accept` (log a warning and carry on) |

Anything else in the entry is the scanner's own configuration, such as `cmd` and `args` for `command`.

### When a scanner fails
**File scanning fails closed.** If a scanner fails, for example ClamAV's signature database is missing, a daemon is down, or the scanner runs past its `timeout`, the file is **held**: it is quarantined as if it were infected, and the operator notice says it was held rather than found infected. Nothing silently passes because a scanner was broken.

A held file may well be clean. Check the scanner, then release the file by hand from the quarantine directory: move it back to where it belongs (renaming it if it was defanged) and run `oputil fb scan` on that area, or upload it again.

TIC imports are the exception: a held TIC payload is not quarantined straight away but kept in the inbound and tried again on later passes, since a sender will not send it again. See [TIC imports](#tic-imports-and-passthrough-echoes).

For a scanner that is not a security control, or one that runs out of quota (a hash lookup service, say), set `onError: accept` on its entry so that a failure lets the file through with a warning in the log.

## The command scanner
`command` runs a program once per file, never through a shell, and maps its exit code to a result.

| Item | Default | Description |
|------|---------|-------------|
| `cmd` | (required) | The program to run. Give a full path if it is not on the `PATH` |
| `args` | `[ "{filePath}" ]` | Its arguments. `{filePath}` (always absolute), `{fileName}`, `{areaTag}`, `{source}` and `{sha256}` are substituted |
| `exitCodes` | `{ clean: [ 0 ], infected: [ 1 ] }` | Exit codes for clean and infected. **Any other exit code is an error**, as is a crash, a signal or a failure to start |
| `signatureRegex` | (none) | Applied to the program's output when the file is infected; the first capture group is the signature name shown in the notice |
| `infectedRegex` | (none) | For a program whose exit code cannot tell "found something" from "failed". If it matches the output, the file is infected whatever the exit code |

Regular expressions are strings, applied with the `m` flag, so `^` and `$` match at each line.

:::caution
`{fileName}` is whatever the uploader called the file, and it may start with `-`. Do not put it where the program would read it as an option. `{filePath}` is always absolute and is the safe choice.
:::

### ClamAV: clamscan and clamdscan
`clamscan` exits `0` for clean, `1` for infected and `2` for an error, which matches the defaults:

```hjson
{
    scanner: command
    cmd: clamscan
    args: [
        "--no-summary"
        "{filePath}"
    ]
    signatureRegex: "^.*: (.+) FOUND$"
}
```

`clamscan` loads the whole signature database every time it runs, which takes seconds and a lot of memory per file. If `clamd` is running, use `clamdscan` instead, with the same exit codes. Add `--fdpass` so that `clamd`, which usually runs as its own user, can read files in ENiGMA½'s upload directories (see [File permissions](#file-permissions)):

```hjson
{
    scanner: command
    cmd: clamdscan
    args: [
        "--no-summary"
        "--fdpass"
        "{filePath}"
    ]
    signatureRegex: "^.*: (.+) FOUND$"
}
```

ClamAV skips files over its `MaxFileSize` and `MaxScanSize` limits **and reports them clean**, unless `AlertExceedsMax yes` is set in `clamd.conf`. With that set, an oversize file is reported as `Heuristics.Limits.Exceeded` and rejected.

### File permissions
Uploads are scanned where they were received, in a temporary directory that only the user ENiGMA½ runs as can open (mode `0700`): one per telnet/SSH upload session and one per REST upload. That is deliberate. These are untrusted files on a shared temporary file system, and the BBS user's group may well be shared with other services.

So a scanner that opens the file **by path as a different user** cannot read uploads, and with the default `onError: hold` every upload is held. This bites, for example, `clamd` given a path to `SCAN` (or `clamdscan` without `--fdpass`), and a `sudo` or `su` wrapper that runs the scanner as another account. Instead, use one of:

* a scanner that runs as the ENiGMA½ user: `clamscan`, or any `command` that does not switch user;
* `clamdscan --fdpass`, which opens the file itself and hands `clamd` the open file descriptor;
* a scanner that streams the file's bytes to its daemon (ClamAV's `INSTREAM`, for example), as a mod scanner can.

TIC inbound and file base storage directories have whatever permissions you gave them.

### Windows Defender
Defender's command-line scanner, `MpCmdRun.exe`, can scan a single file:

```hjson
{
    scanner: command
    cmd: "C:\\Program Files\\Windows Defender\\MpCmdRun.exe"
    args: [
        "-Scan"
        "-ScanType"
        "3"
        "-File"
        "{filePath}"
        "-DisableRemediation"
    ]
    //  exit code 2 means "found something" OR "failed": let the output decide
    exitCodes: {
        clean: [ 0 ]
        infected: [ ]
    }
    infectedRegex: "^Threat\\s+:\\s+(.+)$"
    timeout: 120000
}
```

Some caveats:

* **Exit code 2 is ambiguous.** Defender uses it both for "threats found" and for errors. That is why `infected` above is empty and `infectedRegex` decides: if the output names a threat, the file is infected; if not, exit code 2 is an error and the file is held.
* **It is not on the `PATH`.** The current copy lives under `C:\ProgramData\Microsoft\Windows Defender\Platform\<version>\MpCmdRun.exe`, and the version changes as Defender updates itself. The copy under `C:\Program Files\Windows Defender\` is older but stays put.
* **Microsoft documents it as needing an elevated prompt.** If ENiGMA½ does not run elevated and every file comes back held, that is the likely cause.
* `-DisableRemediation` stops Defender acting on the file itself, so ENiGMA½ decides what happens to it.

### Testing with EICAR
The [EICAR test file](https://www.eicar.org/download-anti-malware-testfile/) is a harmless string every scanner reports as infected. Upload it, or drop it into a storage directory and run `oputil fb scan AREA --virus-scan`, to check your setup end to end. Some scanners also find it inside a zip.

## What happens to a rejected file
### Quarantine
With `failAction: quarantine`, the default, a rejected file is:

1. moved to `quarantinePath`, keeping its name but defanged (`.exe` becomes `.ex_`, see `defangExtensions`, after dropping any trailing dots and spaces), and renamed `FILE(1).EX_` and so on if the name is taken. A name with nothing usable left (`..`, `.`, all dots) or too long for the file system is replaced by `unnamed-` and the start of its SHA-256; the sidecar keeps the original;
2. stripped of any execute permission;
3. given a JSON sidecar beside it, `FILE.EX_.json`, recording the original name, SHA-256, size, where it came from (source, user, area, TIC details), the scanner, its result and signature, and the time.

With `failAction: delete`, the file is deleted and there is no sidecar. A held file is always quarantined.

If an infected file cannot be quarantined (the disk is full, or the quarantine directory cannot be created), it is **deleted instead**, so that it is never left where a later import could pick it up. The log and the operator notice say so. A held file that cannot be quarantined is left where it is, since it may be clean, and the notice says where it still is.

### Operator notice
Each user in `notifyUserIds` gets a private message listing the rejected files: name, where each came from, the scanner and what it found, and where the file went. One message covers a whole upload session, TIC import pass or `oputil` run, so a batch of infected files does not flood the inbox. Rejections are also logged at `warn` level.

### What the uploader sees
A telnet/SSH caller is shown which of their files were refused, with a general reason, "failed the upload check" or "could not be checked", but not what the scanner found. The rest of the batch carries on as normal. A REST client gets a `422` problem response with the same general reason.

The upload menu (`fileBaseUploadFiles`) has these settings for it, in its `config` block or the theme:

| Item | Default | Description |
|------|---------|-------------|
| `art.rejected` | `ULREJECT` | Art for the rejected files page, with a `VM1` list. Optional: without it the list is printed as plain text |
| `rejectedInfoFormat` | `{fileName}: {reason}` | One line per rejected file. Also has `{scanResult}` (`infected` or `held`) and `{signature}` |
| `rejectedInfectedReason` | `failed the upload check` | `{reason}` for an infected file |
| `rejectedHeldReason` | `could not be checked` | `{reason}` for a held file |
| `virusScanStartFormat` | `Scanning for viruses` | Processing page step text while scanning |
| `virusScanFinishFormat` | `Virus scan finished` | Step text when the file passes |
| `virusScanRejectedFormat` | `{fileName} failed the upload check` | Step text, also added to the processing log, when it is rejected |

The processing page can also have a `TL5` indicator for the scan step, like the hash and archive indicators.

## TIC imports and passthrough echoes
Every TIC payload is scanned, whether the echo is stored in a local area or is a passthrough echo carried only for downlinks. A passthrough file is scanned before it is put in transit, so an infected file is never relayed.

An **infected** payload is rejected at once: it is quarantined or deleted, and its `.tic` goes to the `reject` directory as any other rejected TIC does, without the payload. One operator notice covers each import pass.

A **held** payload, one a scanner could not check because it failed, timed out or is not registered, is treated like a payload that has not arrived yet: the `.tic` and the file stay in the inbound, nothing is imported or relayed, and the next import pass tries again. Each pass logs a warning. Once the hold has lasted longer than `tic.holdMaxAgeMs` (48 hours by default; see [TIC Support](tic-support.md)), the payload is quarantined, the `.tic` goes to `reject`, and the operators get a notice. So a scanner outage shorter than that loses nothing.

## oputil
`oputil fb scan` does not scan for viruses unless you ask it to:

```bash
./oputil.js fb scan uploads --virus-scan
```

With `--virus-scan`, each new file is scanned before it is imported, by the entries whose `sources` include `oputil` (or that list no `sources`). A rejected file is reported, not imported, and quarantined or deleted per `failAction`. One notice covers the run. It refuses to start if scanning is disabled.

The file is already in the area's storage directory, where a later plain `fb scan` would import it unscanned, so a file that cannot be moved is reported loudly. An infected file that cannot be quarantined is deleted instead; if it cannot be deleted either, oputil says so and exits with an error. A held file that cannot be quarantined is left in place, and oputil says that it is still there, unscanned.

oputil loads the scanners mods provide by calling each mod's [`registerFileScanners`](#writing-a-scanner) export, and nothing else of the mod: no `moduleInitialize`. If an entry that would run for `oputil` still names a scanner nobody registered, `--virus-scan` refuses to start rather than hold every file.

## Writing a scanner
A scanner is an object with a `scan()` function, registered by name. A mod provides it through a `registerFileScanners` export:

```javascript
// mods/my_scanner/my_scanner.js
exports.moduleInfo = {
    name: 'My Scanner',
    desc: 'Checks files against a list of known bad hashes',
    author: 'You',
};

const knownBad = new Set([
    '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f', // EICAR
]);

exports.registerFileScanners = (registry, cb) => {
    registry.registerScanner('bad_hashes', {
        //  optional startup health check; |entries| are the config entries
        //  that name this scanner
        init(entries, cb) {
            return cb(null);
        },

        scan(filePath, ctx, cb) {
            if (knownBad.has(ctx.sha256)) {
                return cb(null, { result: 'infected', signature: 'Known bad hash' });
            }
            //  not "clean": this scanner only knows bad files
            return cb(null, { result: 'skipped' });
        },
    });
    return cb(null);
};
```

`registerFileScanners(registry, cb)` is called once, both by the BBS at startup (before any mod's `moduleInitialize`) and by `oputil fb scan --virus-scan`, which calls nothing else of the mod. `registry` has `registerScanner(name, scanner)` and `ScanResults`. `cb` is optional: a function declared with only `registry` is done when it returns. A mod that throws, or calls back an error, is logged and skipped.

Because oputil requires the mod file just for this, keep the file free of side effects at load time: start servers, timers and listeners in `moduleInitialize`, not at the top of the file, or oputil will not exit when it is done.

Calling `FileScanner.registerScanner()` (from `core/file_scanner.js`) in `moduleInitialize` still works at BBS startup, but such a scanner is not available to oputil. Prefer the export.

Then name it in config:

```hjson
scanners: [
    {
        scanner: bad_hashes
        onError: accept
    }
]
```

`scan(filePath, ctx, cb)` calls back `(err, { result, signature?, detail? })`:

| `result` | Meaning |
|----------|---------|
| `clean` | Nothing found |
| `infected` | Reject the file. `signature` names what was found |
| `skipped` | No opinion: an unknown hash, a file type or size this scanner does not handle |
| `error` | The scanner failed; `detail` says why. The entry's `onError` decides |

An `err`, a throw, an unknown `result` or no answer within the entry's `timeout` all count as `error`. A file that only gets `skipped` results is accepted.

`ctx` has:

| Item | Description |
|------|-------------|
| `source` | `upload`, `web`, `tic`, `oputil` or `rescan` |
| `fileName` | The file's real name, which may differ from the base name of `filePath` |
| `areaTag` | The destination area, if there is one |
| `user` | The uploading user, for `upload` and `web` |
| `sha256`, `byteSize` | Already worked out; no need to read the file for them |
| `ticInfo` | For `tic`: `area`, `origin`, `from`, `ticFileName`, `passthrough` |
| `options` | The scanner's config entry |
| `timeout`, `abortSignal` | The entry's timeout, and an `AbortSignal` that fires when it runs out. A scanner holding a socket or a child process should stop when it fires |

A scanner returns a verdict only. It must not change, move or delete the file; ENiGMA½ does that.

Registering a name a second time replaces the first scanner, with a warning in the log, so you can replace the built-in `command` scanner if you need to.

## See Also
* [Access & Uploads](acs.md)
* [TIC Support](tic-support.md)
* [oputil](../admin/oputil.md)

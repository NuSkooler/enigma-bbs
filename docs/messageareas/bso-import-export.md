---
layout: page
title: BSO Import / Export
---
The scanner/tosser module `ftn_bso` provides **B**inkley **S**tyle **O**utbound (BSO) import/toss and scan/export of messages EchoMail and NetMail messages. Configuration is supplied in `config.hjson` under `scannerTossers.ftn_bso`.

:information_source: ENiGMA½'s `ftn_bso` module is not a mailer and **makes no attempts** to perfrom packet transport! An external utility such as Binkd is required for this!

Let's look at some of the basic configuration:

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `schedule`  | :+1:     | Sets `import` and `export` schedules. [Later style text parsing](https://bunkat.github.io/later/parsers.html#text) supported. `import` also can utilize a `@watch:<path/to/file>` syntax while `export` additionally supports `@immediate`.  |
| `packetMsgEncoding` | :-1: | Override default `utf8` encoding.
| `defaultNetwork`       | :-1:     | Explicitly set default network (by tag in `messageNetworks.ftn.networks`). If not set, the first found is used.   |
| `nodes`   | :+1:     | Per-node settings. Entries (keys) here support wildcards for a portion of the FTN-style address (e.g.: `21:1/*`). `archiveType` may be set to a FTN supported archive extention that the system supports (TODO); if unset, only .PKT files are produced. `encoding` may be set to override `packetMsgEncoding` on a per-node basis. If the node requires a packet password, set `packetPassword`  |
| `paths` | :-1: | An optional configuration block that can set a `retain` path and/or a `reject` path. These will be used for archiving processed packets. You may additionally override the default `outbound`, `inbound`, and `secInbound` (secure inbound) *base* paths for packet processing. |
| `packetTargetByteSize`  | :-1: | Overrides the system *target* packet (.pkt) size of 512000 bytes (512k) |
| `bundleTargetByteSize`  | :-1: | Overrides the system *target* ArcMail bundle size of 2048000 bytes (2M) | 

## Scheduling
Schedules can be defined for importing and exporting via `import` and `export` under `schedule`. Each entry is allowed a "free form" text and/or special indicators for immediate export or watch file triggers.

  * `@immediate`: A message will be immediately exported if this trigger is defined in a schedule. Only used for `export`.
  * `@watch:/path/to/file`: This trigger watches the path specified for changes and will trigger an import or export when such events occur. Only used for `import`.
  * Free form text can be things like `at 5:00 pm` or `every 2 hours`. 
  
See [Later text parsing documentation](http://bunkat.github.io/later/parsers.html#text) for more information.

### Example Schedule Configuration

```hjson
{
  scannerTossers: {
    ftn_bso: {
      schedule: {
        import: every 1 hours or @watch:/path/to/watchfile.ext
        export: every 1 hours or @immediate
      }
    }
  }
}
```

## Nodes
The `nodes` section defines how to export messages for one or more uplinks. 

A node entry starts with a FTN style address (up to 5D) **as a key** in `config.hjson`. This key may contain wildcard(s) for net/zone/node/point/domain. 

| Config Item      | Required | Description                                                                     |
|------------------|----------|---------------------------------------------------------------------------------|
| `packetType`     | :-1:     | `2`, `2.2`, or `2+`. Defaults to `2+` for modern mailer compatiability          |
| `packetPassword` | :-1:     | Password for the packet                                                         |
| `encoding`       | :-1:     | Encoding to use for message bodies; Defaults to `utf-8`                         |
| `archiveType`    | :-1:     | Specifies the archive type for ArcMail bundles. Must be a valid archiver name such as `zip` (See archiver configuration) |

**Example**:
```hjson
{
  scannerTossers: {
    ftn_bso: {
      nodes: {
        "21:*": {
          packetType: 2+
          packetPassword: mypass
          encoding: cp437
          archiveType: zip
        }
      }
    }
  }
}
```

## A More Complete Example
Below is a more complete example showing the sections described above.

```hjson
scannerTossers: {
  ftn_bso: {
    schedule: {
      //  Check every 30m, or whenever the "toss!.now" file is touched (ie: by Binkd)
      import: every 30 minutes or @watch:/enigma-bbs/mail/ftn_in/toss!.now

      //  Export immediately, but also check every 15m to be sure
      export: every 15 minutes or @immediate
    }

    // optional
    paths: {
      reject: /path/to/store/bad/packets/
      retain: /path/to/store/good/packets/
    }

    //  Override default FTN/BSO packet encoding. Defaults to 'utf8'
    packetMsgEncoding: utf8

    defaultNetwork: fsxnet

    nodes: {
      "21:1/100" : {            //  May also contain wildcards, ie: "21:1/*"
        archiveType: ZIP        //  By-ext archive type: ZIP, ARJ, ..., optional.
        encoding: utf8          //  Encoding for exported messages
        packetPassword: MUHPA55 //  FTN .PKT password, optional

        tic: {
          //  See TIC docs
        }
      }
    }

    netMail: {
      //  See NetMail docs
    }

    ticAreas: {
      //  See TIC docs
    }
  }
}
```
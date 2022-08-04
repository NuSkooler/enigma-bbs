---
layout: page
title: BSO Import / Export
---
## BSO Import / Export
The scanner/tosser module `ftn_bso` provides **B**inkley **S**tyle **O**utbound (BSO) import/toss and scan/export of messages EchoMail and NetMail messages. Configuration is supplied in `config.hjson` under `scannerTossers.ftn_bso`.

> :information_source: ENiGMA½'s `ftn_bso` module is not a mailer and **makes no attempts to perform packet transport**! An external [mailer](http://www.filegate.net/bbsmailers.htm) such as [Binkd](https://github.com/pgul/binkd) is required for this task!

### Configuration
Let's look at some of the basic configuration:

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `schedule`  | :+1: | Sets `import` and `export` schedules. [Later style text parsing](https://bunkat.github.io/later/parsers.html#text) supported. `import` also can utilize a `@watch:<path/to/file>` syntax while `export` additionally supports `@immediate`. |
| `packetMsgEncoding` | :-1: | Override default `utf8` encoding.
| `defaultNetwork` | :-1: | Explicitly set default network (by tag found within `messageNetworks.ftn.networks`). If not set, the first found is used. |
| `nodes` | :+1: | Per-node settings. Entries (keys) here support wildcards for a portion of the FTN-style address (e.g.: `21:1/*`). See **Nodes** below.
| `paths` | :-1: | An optional configuration block that can set a additional paths or override defaults. See **Paths** below. |
| `packetTargetByteSize`  | :-1: | Overrides the system *target* packet (.pkt) size of 512000 bytes (512k) |
| `bundleTargetByteSize`  | :-1: | Overrides the system *target* ArcMail bundle size of 2048000 bytes (2M) |

#### Nodes
The `nodes` section defines how to export messages for one or more uplinks.

A node entry starts with a [FTN address](http://ftsc.org/docs/old/fsp-1028.001) (up to 5D) **as a key** in `config.hjson`. This key may contain wildcard(s) for net/zone/node/point/domain.

| Config Item      | Required | Description                                                                     |
|------------------|----------|---------------------------------------------------------------------------------|
| `packetType`     | :-1:     | `2`, `2.2`, or `2+`. Defaults to `2+` for modern mailer compatibility. |
| `packetPassword` | :-1:     | Optional password for the packet |
| `encoding`       | :-1:     | Encoding to use for message bodies; Defaults to `utf-8`. |
| `archiveType`    | :-1:     | Specifies the archive type (by extension or MIME type) for ArcMail bundles. This should be `zip` (or `application/zip`) for most setups. Other valid examples include `arc`, `arj`, `lhz`, `pak`, `sqz`, or `zoo`. See [Archivers](../configuration/archivers.md) for more information. |

**Example**:
```hjson
{
  scannerTossers: {
    ftn_bso: {
      nodes: {
        "21:*": { // wildcard address
          packetType: 2+
          packetPassword: D@TP4SS
          encoding: cp437
          archiveType: zip
        }
      }
    }
  }
}
```

#### Paths
Paths for packet files work out of the box and are relative to your install directory. If you want to configure `reject` or `retain` to keep rejected/imported packet files respectively, set those values. You may override defaults as well.

| Key | Description | Default |
|-----|-------------|---------|
| `outbound` | *Base* path to write outbound (exported) packet files and bundles. | `enigma-bbs/mail/ftn_out/` |
| `inbound` | *Base* path to write inbound (ie: those written by an external mailer) packet files an bundles. | `enigma-bbs/mail/ftn_in/` |
| `secInbound` | *Base* path to write **secure** inbound packet files and bundles. | `enigma-bbs/mail/ftn_secin/` |
| `reject` | Path in which to write rejected packet files. | No default |
| `retain` | Path in which to write imported packet files. Useful for debugging or if you wish to archive the raw .pkt files. | No default |

### Scheduling
Schedules can be defined for importing and exporting via `import` and `export` under `schedule`. Each entry is allowed a "free form" text and/or special indicators for immediate export or watch file triggers.

* `@immediate`: A message will be immediately exported if this trigger is defined in a schedule. Only used for `export`.
* `@watch:/path/to/file`: This trigger watches the path specified for changes and will trigger an import or export when such events occur. Only used for `import`.
* Free form [Later style](https://bunkat.github.io/later/parsers.html#text) text — can be things like `at 5:00 pm` or `every 2 hours`.

See [Later text parsing documentation](http://bunkat.github.io/later/parsers.html#text) for more information.

#### Example Schedule Configuration

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

### A More Complete Example
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

## Binkd
Since Binkd is a very common mailer, a few tips on integrating it with ENiGMA½.

### Example Binkd Configuration
Below is an **example** Binkd configuration file that may help serve as a reference.

```bash
# Number @ end is the root zone
# Note that fsxNet is our *default* FTN so we use "outbound" here!
domain fsxnet /home/enigma/enigma-bbs/mail/ftn_out/outbound 21
domain araknet /home/enigma/enigma-bbs/mail/ftn_out/araknet 10

# Our assigned addresses
address 21:1/1234@fsxnet
address 10:101/1234@araknet

# Info about our board/op
sysname "My BBS"
location "Somewhere Out There"
sysop "SysOp"

nodeinfo 115200,TCP,BINKP
try 10
hold 600
send-if-pwd

log /var/log/binkd/binkd.log
loglevel 4
conlog 4

percents
printq
backresolv

inbound /home/enigma/enigma-bbs/mail/ftn_in
temp-inbound /home/enigma/enigma-bbs/mail/ftn_in_temp

minfree 2048
minfree-nonsecure 2048

kill-dup-partial-files
kill-old-partial-files 86400

prescan

# fsxNet - Agency HUB
node 21:1/100@fsxnet -md agency.bbs.nz:24556 SOMEPASS c

# ArakNet
node 10:101/0@araknet -md whq.araknet.xyz:24556 SOMEPASS c

# our listening port (default=24554)
iport 54554

pid-file /var/run/binkd/binkd.pid

# touch a watch file when files are received to kick of toss
# ENiGMA can monitor this (see @watch information above)
flag /home/enigma/enigma-bbs/mail/ftn_in/toss!.now *.su? *.mo? *.tu? *.we? *.th? *.fr? *.sa? *.pkt *.tic

# nuke old .bsy/.csy files after 24 hours
kill-old-bsy 43200
```

### Scheduling Polls
Binkd does not have it's own scheduler. Instead, you'll need to set up an Event Scheduler entry or perhaps a cron job:

First, create a script that runs through all of your uplinks. For example:
```bash
#!/bin/bash
UPLINKS=("21:1/100@fsxnet" "80:774/1@retronet" "10:101/0@araknet")
for uplink in "${UPLINKS[@]}"
do
	/usr/local/sbin/binkd -p -P $uplink /home/enigma/xibalba/misc/binkd_xibalba.conf
done
```

Now, create an Event Scheduler entry in your `config.hjson`. As an example:
```hjson
eventScheduler: {
  events: {
    pollWithBink: {
      //  execute the script above very 1 hours
      schedule: every 1 hours
      action: @execute:/path/to/poll_bink.sh
    }
  }
}
```

## Additional Resources
* [Blog entry on setting up ENiGMA + Binkd on CentOS7](https://l33t.codes/enigma-12-binkd-on-centos-7/). Note that this references an **older version**, so be wary of the `config.hjson` references!
* [Setting up FTN-style message networks with ENiGMA½ BBS](https://medium.com/@alpha_11845/setting-up-ftn-style-message-networks-with-enigma%C2%BD-bbs-709b22a1ae0d) by Alpha.
---
layout: page
title: Message Networks
---
ENiGMA½ considers all non-ENiGMA½, non-local messages (and their networks, such as FTN "external". That is, messages are only imported and exported from/to such a networks. Configuring such external message networks in ENiGMA½ requires three sections in your `config.hjson`.

1. `messageNetworks.<networkType>.networks`: declares available networks.
2. `messageNetworks.<networkType>.areas`: establishes local area mappings and per-area specifics.
3. `scannerTossers.<name>`: general configuration for the scanner/tosser (import/export). This is also where we configure per-node settings.

## FTN Networks 
FidoNet and FidoNet style (FTN) networks as well as a FTN/BSO scanner/tosser (`ftn_bso` module) are configured via the `messageNetworks.ftn` and `scannerTossers.ftn_bso` blocks in `config.hjson`.

:information_source: ENiGMA½'s `ftn_bso` module is not a mailer and **makes no attempts** to perfrom packet transport! An external utility such as Binkd is required for this

### Networks
The `networks` block a per-network configuration where each entry's key may be referenced elswhere in `config.hjson`.

Example: the following example declares two networks: `agoranet` and `fsxnet`:
```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        araknet: {
          defaultZone: 10
          localAddress: "10:101/9"
        }
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
        }
      }
    }
  }
}
```

### Areas
The `areas` section describes a mapping of local **area tags** configured in your `messageConferences` (see [Configuring a Message Area](configuring-a-message-area.md)) to a message network (described above), a FTN specific area tag, and remote uplink address(s). This section can be thought of similar to the *AREAS.BBS* file used by other BBS packages. 

When ENiGMA½ imports messages, they will be placed in the local area that matches key under `areas` while exported messages will be sent to the relevant `network`.

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `network`   | :+1:     | Associated network from the `networks` section above |    
| `tag`       | :+1:     | FTN area tag (ie: `FSX_GEN`) |
| `uplinks`   | :+1:     | An array of FTN address uplink(s) for this network |

Example:
```hjson
{
  messageNetworks: {
    ftn: {
      areas: {
        fsx_general:        //  *local* tag found within messageConferences
          network: fsxnet   //  that we are mapping to this network
          tag: FSX_GEN      //  ...and this remote FTN-specific tag
          uplinks: [ "21:1/100" ] // a single string also allowed here
        }
      }
    }
  }
}
```

### FTN/BSO Scanner Tosser

| Config Item | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `schedule`  | :+1:     | Sets `import` and `export` schedules. [Later style text parsing](https://bunkat.github.io/later/parsers.html#text) supported. `import` also can utilize a `@watch:<path/to/file>` syntax while `export` additionally supports `@immediate`.  |
| `packetMsgEncoding` | :-1: | Override default `utf8` encoding.
| `defaultNetwork`       | :-1:     | Explicitly set default network (by tag in `messageNetworks.ftn.networks`). If not set, the first found is used.   |
| `nodes`   | :+1:     | Per-node settings. Entries (keys) here support wildcards for a portion of the FTN-style address (e.g.: `21:1/*`). `archiveType` may be set to a FTN supported archive extention that the system supports (TODO); if unset, only .PKT files are produced. `encoding` may be set to override `packetMsgEncoding` on a per-node basis. If the node requires a packet password, set `packetPassword`  |

Example:
```hjson
scannerTossers: {
  ftn_bso: {
    schedule: {
      //  Check every 30m, or whenever the "toss!.now" file is touched (ie: by Binkd)
      import: every 30 minutes or @watch:/enigma-bbs/mail/ftn_in/toss!.now

      //  Export immediately, but also check every 15m to be sure
      export: every 15 minutes or @immediate
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
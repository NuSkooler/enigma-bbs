---
layout: page
title: Message Networks
---
## Message Networks
ENiGMA½ considers all non-ENiGMA½, non-local messages (and their networks, such as FTN "external". That is, messages are only imported and exported from/to such a networks. Configuring such external message networks in ENiGMA½ requires three sections in your `config.hjson`.

1. `messageNetworks.<networkType>.networks`: declares available networks.
2. `messageNetworks.<networkType>.areas`: establishes local area mappings and per-area specifics.
3. `scannerTossers.<name>`: general configuration for the scanner/tosser (import/export). This is also where we configure per-node settings.

### FTN Networks 
FidoNet and FidoNet style (FTN) networks as well as a [FTN/BSO scanner/tosser](bso-import-export.md) (`ftn_bso` module) are configured via the `messageNetworks.ftn` and `scannerTossers.ftn_bso` blocks in `config.hjson`.

:information_source: ENiGMA½'s `ftn_bso` module is **not a mailer** and makes **no attempts** to perform packet transport! An external utility such as Binkd is required for this!

#### Networks
The `networks` block a per-network configuration where each entry's key may be referenced elsewhere in `config.hjson`.

Example: the following example declares two networks: `araknet` and `fsxnet`:
```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        // it is recommended to use lowercase network tags
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
        }

        araknet: {
          defaultZone: 10
          localAddress: "10:101/9"
        }
      }
    }
  }
}
```

#### Areas
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
        // it is recommended to use lowercase area tags
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

:information_source: You can import `AREAS.BBS` or FTN style `.NA` files using [oputil](/docs/admin/oputil.md)!

### A More Complete Example
Below is a more complete *example* illustrating some of the concepts above:

```hjson
{
  messageNetworks: {
    ftn: {
      networks: {        
        fsxnet: {
          defaultZone: 21
          localAddress: "21:1/121"
        }
      }

      areas: {        
        fsx_general: {
          network: fsxnet

          //  ie as found in your info packs .NA file
          tag: FSX_GEN

          uplinks: [ "21:1/100" ]
        }
      }
    }
  }
}
```

:information_source: Remember for a complete FTN experience, you'll probably also want to configure [FTN/BSO scanner/tosser](bso-import-export.md) settings.

### FTN/BSO Scanner Tosser
Please see the [FTN/BSO Scanner/Tosser](bso-import-export.md) documentation for information on this area.

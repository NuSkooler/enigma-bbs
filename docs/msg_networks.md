# Message Networks
Message networks are configured in `messageNetworks` section of `config.hjson`. Each network type has it's own sub section such as `ftn` for FidoNet Technology Network (FTN) style networks. Message Networks tie directly with [Message Areas](msg_conf_area.md) that are also defined in `config.hjson`.

**Members**:
  * `ftn`: Configure FTN networks (described below)
  * `originLine` (optional): Overrwrite the default origin line for networks that support it. For example: `originLine: Xibalba - xibalba.l33t.codes:44510`

## FidoNet Technology Network (FTN)
FTN networks are configured under the `messageNetworks::ftn` section of `config.hjson`.

### Networks
The `networks` section contains a sub section for network(s) you wish you join your board with. Each entry's key name can be referenced elsewhere in `config.hjson` for FTN oriented configurations.

**Members**:
  * `localAddress` (required): FTN address of **your local system**
  
**Example**:
```hjson
{
  messageNetworks: {
    ftn: {
      networks: {
        agoranet: {
          localAddress: "46:3/102"
        }
      }
    }
  }
}
```
  
### Areas
The `areas` section describes a mapping of local **area tags** found in your `messageConferences` to a message network (from `networks` described previously), a FTN specific area tag, and remote uplink address(s). This section can be thought of similar to the *AREAS.BBS* file used by other BBS packages.

When importing, messages will be placed in the local area that matches key under `areas`.

**Members**:
  * `network` (required): Associated network from the `networks` section
  * `tag` (required): FTN area tag
  * `uplinks`: An array of FTN address uplink(s) for this network

**Example**:
```hjson
{
  messageNetworks: {
    ftn: {
      areas: {
        agoranet_bbs: { /* found within messageConferences */
          network: agoranet
          tag: AGN_BBS
          uplinks: "46:1/100"
        }
      }
    }
  }
}
```

### BSO Import / Export
The scanner/tosser module `ftn_bso` provides **B**inkley **S**tyle **O**utbound (BSO) import/toss & scan/export of messages EchoMail and NetMail messages. Configuration is supplied in `config.hjson` under `scannerTossers::ftn_bso`.

**Members**:
  * `defaultZone` (required): Sets the default BSO outbound zone
  * `defaultNetwork` (optional): Sets the default network name from `messageNetworks::ftn::networks`. **Required if more than one network is defined**.
  * `paths` (optional): Override default paths set by the system. This section may contain `outbound`, `inbound`, and `secInbound`.
  * `packetTargetByteSize` (optional): Overrides the system *target* packet (.pkt) size of 512000 bytes (512k)
  * `bundleTargetByteSize` (optional): Overrides the system *target* ArcMail bundle size of 2048000 bytes (2M)
  * `schedule` (required): See Scheduling
  * `nodes` (required): See Nodes

#### Nodes
The `nodes` section defines how to export messages for one or more uplinks. 

A node entry starts with a FTN style address (up to 5D) **as a key** in `config.hjson`. This key may contain wildcard(s) for net/zone/node/point/domain.

**Members**:
  * `packetType` (optional): `2`, `2.2`, or `2+`. Defaults to `2+` for modern mailer compatiability
  * `packetPassword` (optional): Password for the packet
  * `encoding` (optional): Encoding to use for message bodies; Defaults to `utf-8`
  * `archiveType` (optional): Specifies the archive type for ArcMail bundles. Must be a valid archiver name such as `zip` (See archiver configuration)

**Example**:
```hjson
{
  scannerTossers: {
    ftn_bso: {
      nodes: {
        "46:*: {
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

#### Scheduling
Schedules can be defined for importing and exporting via `import` and `export` under `schedule`. Each entry is allowed a "free form" text and/or special indicators for immediate export or watch file triggers.

  * `@immediate`: A message will be immediately exported if this trigger is defined in a schedule. Only used for `export`.
  * `@watch:/path/to/file`: This trigger watches the path specified for changes and will trigger an import or export when such events occur. Only used for `import`.
  * Free form text can be things like `at 5:00 pm` or `every 2 hours`. 
  
See [Later text parsing documentation](http://bunkat.github.io/later/parsers.html#text) for more information.

**Example**:
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
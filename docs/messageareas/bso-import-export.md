---
layout: page
title: BSO Import / Export
---
The scanner/tosser module `ftn_bso` provides **B**inkley **S**tyle **O**utbound (BSO) import/toss and 
scan/export of messages EchoMail and NetMail messages. Configuration is supplied in `config.hjson` 
under `scannerTossers::ftn_bso`.

| Config Item             | Required | Description                                                                     |
|-------------------------|----------|---------------------------------------------------------------------------------|
| `defaultZone`           | :+1:     | Sets the default BSO outbound zone
| `defaultNetwork`        | :-1:     | Sets the default network name from `messageNetworks.ftn.networks`. **Required if more than one network is defined**.
| `paths`                 | :-1:     | Override default paths set by the system. This section may contain `outbound`, `inbound`, and `secInbound`.
| `packetTargetByteSize`  | :-1:     | Overrides the system *target* packet (.pkt) size of 512000 bytes (512k)
| `bundleTargetByteSize`  | :-1:     | Overrides the system *target* ArcMail bundle size of 2048000 bytes (2M)
| `schedule`              | :+1:     | See Scheduling
| `nodes`                 | :+1:     | See Nodes

## Scheduling
Schedules can be defined for importing and exporting via `import` and `export` under `schedule`. 
Each entry is allowed a "free form" text and/or special indicators for immediate export or watch 
file triggers.

  * `@immediate`: A message will be immediately exported if this trigger is defined in a schedule. Only used for `export`.
  * `@watch:/path/to/file`: This trigger watches the path specified for changes and will trigger an import or export when such events occur. Only used for `import`.
  * Free form text can be things like `at 5:00 pm` or `every 2 hours`. 
  
See [Later text parsing documentation](http://bunkat.github.io/later/parsers.html#text) for more information.

### Example Configuration

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

A node entry starts with a FTN style address (up to 5D) **as a key** in `config.hjson`. This key may 
contain wildcard(s) for net/zone/node/point/domain. 

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
        "46:*": {
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
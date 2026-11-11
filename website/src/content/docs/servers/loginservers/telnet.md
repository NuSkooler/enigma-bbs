---
title: Telnet Server
description: "The Telnet login server and its configuration keys."
sidebar:
    order: 1
---
## Telnet Login Server
The Telnet *login server* provides a standard **non-secure** Telnet login experience.

## Configuration
The following configuration can be made in `config.hjson` under the `loginServers.telnet` block:

| Key | Required | Description |
|------|----------|-------------|
| `enabled` | No | Defaults to `true`. Set to `false` to disable Telnet. |
| `port` | No | Override the default port of `8888`. |
| `address` | No | Sets an explicit bind address. |
| `firstMenu` | No | First menu a telnet connected user is presented with. Defaults to `telnetConnected`. |

### Example Configuration
```hjson
{
  loginServers: {
    telnet: {
      enabled: true
      port: 8888
    }
  }
}
```

## Additional Listeners
The Telnet server can listen on more ports than its main one. Add each under `loginServers.telnet.listeners`, keyed by a name of your choosing. A port can send its callers to a different first menu, which is useful for a separate board entrance on its own port.

| Key | Required | Description |
|------|----------|-------------|
| `port` | Yes | Port to listen on. |
| `address` | No | Bind address. Defaults to the main Telnet `address`. |
| `firstMenu` | No | First menu for callers on this port. Defaults to the main Telnet `firstMenu`. |
| `emulation` | No | Terminal emulation for callers on this port, for example `petscii`. |
| `enabled` | No | Defaults to `true`. Set to `false` to leave the listener out without removing it. Read at startup: a change to `port`, `address` or `enabled` needs a restart. |

`ansi` and `petscii` are implemented today; see [PETSCII (Commodore) Callers](./petscii.md). Any other value is recorded and falls back to ANSI.

Additional listeners run only while the main Telnet server is enabled. A listener with a missing or invalid port, one on a port already in use by the main server or another listener, or one that fails to bind is logged as an error and skipped; the main listener and the rest of the board start as normal.

### Example Configuration
```hjson
{
  loginServers: {
    telnet: {
      port: 8888
      listeners: {
        retro: {
          port: 6400
          firstMenu: retroConnected
          emulation: petscii
        }
        local: {
          port: 8890
          address: 127.0.0.1
        }
      }
    }
  }
}
```

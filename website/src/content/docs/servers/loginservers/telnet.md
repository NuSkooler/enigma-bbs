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



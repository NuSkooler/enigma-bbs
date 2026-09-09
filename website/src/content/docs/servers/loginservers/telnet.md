---
layout: page
title: Telnet Server
---
## Telnet Login Server
The Telnet *login server* provides a standard **non-secure** Telnet login experience.

## Configuration
The following configuration can be made in `config.hjson` under the `loginServers.telnet` block:

| Key | Required | Description |
|------|----------|-------------|
| `enabled` | :-1: Defaults to `true`. Set to `false` to disable Telnet |
| `port` | :-1: | Override the default port of `8888`. |
| `address` | :-1: | Sets an explicit bind address. |
| `firstMenu` | :-1: | First menu a telnet connected user is presented with. Defaults to `telnetConnected`. |

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



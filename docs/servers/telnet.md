---
layout: page
title: Telnet Server
---

Telnet is enabled by default on port `8888` in `config.hjson`:

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

### Telnet Server Options

| Option              | Description
|---------------------|--------------------------------------------------------------------------------------|
| `firstMenu`		  | First menu a telnet connected user is presented with
| `enabled`           | Enable/disable SSH server
| `port`              | Configure a custom port for the SSH server

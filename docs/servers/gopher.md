---
layout: page
title: Gopher Server
---
## The Gopher Content Server
The Gopher *content server* provides access to publicly exposed message conferences and areas over Gopher (gopher://).

## Configuration
Gopher configuration is found in `contentServers.gopher` in `config.hjson`.

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable Gopher |
| `port` | :-1: | Override the default port of `8070` |
| `publicHostName` | :+1: | Set the **public** hostname/domain that Gopher will serve to the outside world. Example: `myfancybbs.com` |
| `publicPort` | :+1: | Set the **public** port that Gopher will serve to the outside world. |
| `messageConferences` | :+1: | An map of *conference tags* to *area tags* that are publicly exposed via Gopher. See example below. |

Notes on `publicHostName` and `publicPort`:
The Gopher protocol serves content that contains host/domain and port even when referencing it's own documents. Due to this, these members must be set to your publicly addressable Gopher server!

### Example
Let's suppose you are serving Gopher for your BBS at `myfancybbs.com`. Your ENiGMA½ system is listening on the default Gopher `port` of 8070 but you're behind a firewall and want port 70 exposed to the public. Lastly, you want to expose some fsxNet areas:

```hjson
contentServers: {
    gopher: {
        enabled: true
        publicHostName: myfancybbs.com
        publicPort: 70

        messageConferences: {
            fsxnet: { // fsxNet's conf tag
                // Areas of fsxNet we want to expose:
                "fsx_gen", "fsx_bbs"
            }
        }
    }
}
```

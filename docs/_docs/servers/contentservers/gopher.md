---
layout: page
title: Gopher Server
---
## The Gopher Content Server
The Gopher *content server* provides access to publicly exposed message conferences and areas over Gopher (gopher://) as well as any other content you wish to serve in your Gopher Hole!

## Configuration
Gopher configuration is found in `contentServers.gopher` in `config.hjson`.

| Item | Required | Description |
|------|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable Gopher |
| `staticRoot` | :+1: | Sets the path serving as the static root path for all Gopher content. Defaults to `enigma-bbs/gopher`.<br>See also **Gophermap's** below |
| `port` | :-1: | Override the default port of `8070` |
| `publicHostname` | :+1: | Set the **public** hostname/domain that Gopher will serve to the outside world. Example: `myfancybbs.com` |
| `publicPort` | :+1: | Set the **public** port that Gopher will serve to the outside world. |
| `messageConferences` | :-1: | An map of *conference tags* to *area tags* that are publicly exposed via Gopher. See example below. |

Notes on `publicHostname` and `publicPort`:
The Gopher protocol serves content that contains host/domain and port even when referencing it's own documents. Due to this, these members must be set to your publicly addressable Gopher server!

## Gophermap's
[Gophermap's](https://en.wikipedia.org/wiki/Gopher_(protocol)#Source_code_of_a_menu) are how to build menus for your Gopher Hole. Each map is a simple text file named `gophermap` (all lowercase, no extension) with DOS style CRLF endings.

Within any directory nested within your `staticRoot` may live a `gophermap`. A template may be found in the `enigma-bbsmisc` directory.

ENiGMA will pre-process `gophermap` files replacing in following variables:
* `{publicHostname}`: The public hostname from your config.
* `{publicPort}`: The public port from your config.

> :information_source: See [Wikipedia](https://en.wikipedia.org/wiki/Gopher_(protocol)#Source_code_of_a_menu) for more information on the `gophermap` format.

> :information_source: See [RFC 1436](https://tools.ietf.org/html/rfc1436) for the original Gopher spec.

> :bulb: Tools such as [gfu](https://rawtext.club/~sloum/gfu.html) may help you with `gophermap`'s

### Example Gophermap
An example `gophermap` living in `enigma-bbs/gopher`:
```
iWelcome to a Gopher server!        {publicHostname}    {publicPort}
1Public Message Area    /msgarea    {publicHostname}    {publicPort}
.
```

### Example
Let's suppose you are serving Gopher for your BBS at `myfancybbs.com`. Your ENiGMA½ system is listening on the default Gopher `port` of 8070 but you're behind a firewall and want port 70 exposed to the public. Lastly, you want to expose some fsxNet areas:

```hjson
contentServers: {
    gopher: {
        enabled: true
        publicHostname: myfancybbs.com
        publicPort: 70

        //  Expose some public message conferences/areas
        messageConferences: {
            fsxnet: { // fsxNet's conf tag
                // Areas of fsxNet we want to expose:
                "fsx_gen", "fsx_bbs"
            }
        }
    }
}
```

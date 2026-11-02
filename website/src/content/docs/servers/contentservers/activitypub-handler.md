---
title: ActivityPub Web Handler
description: "Experimental ActivityPub federation — actors, inboxes and Fediverse messaging."
sidebar:
    order: 7
---
The ActivityPub ([activitypub.js](https://github.com/NuSkooler/enigma-bbs/blob/master/core/servers/content/web_handlers/activitypub.js)) provides [ActivityPub](https://www.w3.org/TR/activitypub/) support currently compatible with [Mastodon](https://joinmastodon.org/) and perhaps similar ActivityPub systems within the [Fediverse](https://en.wikipedia.org/wiki/Fediverse) allowing direct and public messaging, following/followers, etc. to be integrated with the ENiGMA½ BBS system.

## Supported Features
* ActivityPub with Mastodon support
* Users are generated a random avatar once enabled with the ability to change them within their ActivityPub configuration
* Social Manager
* Actor search (that is, other users within the Fediverse)
* Private and public messaging to/from the Fediverse

## Configuration
### Enabling ActivityPub
Full ActivityPub support requires the [Web Server](./web-server.md) module be enabled as well as a number of Web Handlers. Each handler configured within the `contentServers.web.handlers` block keys below of your `config.hjson` must be set to `enabled: true`:

| Handler | Key | Description | Default |
|---------|-----|-------------|---------|
| [WebFinger](./webfinger-handler.md) | `webFinger` | Allows other servers to discover your user/Actors | disabled |
| System General | `systemGeneral` | Serves avatar images | enabled |
| NodeInfo2 | `nodeInfo2` | Allows other systems to query information about your node | enabled |
| ActivityPub | `activityPub` | Described within this file | disabled |

**Example**
```hjson
contentServers: {
    web: {
        handlers: {
            webFinger: {
                enabled: true
            }
            // ...
            activityPub: {
                enabled: true
            }
        }
    }
}
```

### Configuration Keys
| Key | Description |
| ----|-------------|
| `enabled` | Boolean. Set to `true` to enable ActivityPub services |
| `selfTemplate` | String. Provide a fully qualified, or relative to [static root](./web-server.md#static-root) path to a template file for fetching profile information. Defaults to the same file used for [WebFinger](./webfinger-handler.md) queries; See [WebFinger](./webfinger-handler.md#profile-template) for more information. |
| `allowInsecureHttp` | Boolean. Allow plain `http://` requests to remote servers. For local development and testing only; see [Outbound Requests and Limits](#outbound-requests-and-limits). Defaults to `false`. |
| `maxInboxBodyBytes` | Number. Largest inbox request body accepted, in bytes. A larger request is refused with `413`. Defaults to `1048576` (1 MiB). |
| `maxResponseBodyBytes` | Number. Largest response accepted from a remote server (an actor, a Note, a WebFinger lookup, a delivery's answer), in bytes. Defaults to `524288` (512 KiB). |
| `outboundFetchLimits` | Object. Limits on the fetches an incoming inbox request may cause; see [Outbound Requests and Limits](#outbound-requests-and-limits). Members: `perHostConcurrency` (fetches from one remote host at once, default `4`), `perHostPerMinute` (fetches from one remote host per minute, default `60`), `globalConcurrency` (fetches at once, board wide, default `32`) and `globalPerMinute` (fetches per minute, board wide, default `600`). A value that is not a positive number uses its default. |

### Configuring Defaults
#### General
General ActivityPub configuration can be found within the `activityPub` block:

| Key | Description | Default |
| ----|-------------|---------|
| `autoSignatures` | Include auto-signatures in ActivityPub outgoing message/Notes? | `false` |
| `maxMessageLength` | Max single message/Note length in characters. Note that longer lengths *are* generally allowed by remote systems. | `500` |

#### Default User Settings
Settings applied to new users or users first enabling ActivityPub are found within `users.activityPub` with the following members:

| Key | Description | Default |
| ----|-------------|---------|
| `enabled` | Enabled for users by default? | `false` |
| `manuallyApproveFollowers` | Do users need to manually approve followers? | `false` |
| `hideSocialGraph` | Hide users social graph? (followers, following, ...) | `false` |
| `showRealName` | Show real name? | `true` |

## Outbound Requests and Limits
ENiGMA½ contacts remote servers to look up actors (including the key that signed an incoming request), to resolve handles with WebFinger, to fetch Notes, and to deliver activities.

### Address Checks
ENiGMA½ will not connect to a remote server whose name resolves to a loopback, private, link-local (including cloud metadata), shared (CGNAT), multicast, documentation or otherwise reserved address, IPv4 or IPv6. The same applies to the IPv4-mapped and NAT64 forms of those addresses, to addresses given literally in a URL, and to names such as `localhost` or anything under `.local`, `.internal` or `.lan`. Every address a name resolves to is checked, at the moment of connecting, and again for each redirect; at most 3 redirects are followed. A name refused for the address it resolves to is logged as a warning, with the host and the address.

### allowInsecureHttp
`allowInsecureHttp: true` is for local development and testing only, such as federating with a test server on your LAN that has no TLS. It allows `http://` URLs and skips the address checks for them, and a WebFinger lookup whose `https://` attempt fails falls back to `http://` only while it is set. `https://` URLs are always checked. While it is set, ENiGMA½ logs a warning when ActivityPub starts.

### Fetch Limits
The fetches an incoming inbox request causes (the sender's actor and key, a forwarded or boosted Note, a handle lookup) are limited per remote host and board wide by `outboundFetchLimits`, and to 16 per request. A request that goes over a limit is answered `503 Service Unavailable` with `Retry-After: 60`; Mastodon, GoToSocial and similar servers deliver it again later. Outbound deliveries, and lookups a local user makes (an actor search, for example), are not limited.

```hjson
contentServers: {
    web: {
        handlers: {
            activityPub: {
                enabled: true
                outboundFetchLimits: {
                    perHostConcurrency: 4
                    perHostPerMinute: 60
                    globalConcurrency: 32
                    globalPerMinute: 600
                }
            }
        }
    }
}
```

The limits are kept per remote host, not per sender. Heavy traffic that names one host can therefore use up that host's allowance, and activities from that host are delayed (answered `503`) until it subsides. Senders retry, so they arrive later rather than being lost.

### Failed Lookups
A failed actor or WebFinger lookup is remembered and not repeated for a while: 15 minutes when the remote server refused or answered with something unusable (a `4xx` other than `408` or `429`, an invalid document, a refused address), and 2 minutes for anything that may clear up by itself (timeouts, `5xx`, `408`, `429`, connection errors). A lookup refused by the fetch limits is not remembered.

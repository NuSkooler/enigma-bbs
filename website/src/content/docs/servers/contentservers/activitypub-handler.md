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
| `allowedPrivateAddresses` | Array of strings. IPv4 or IPv6 addresses or CIDRs (`10.0.0.0/8`, `fd00::/8`; a bare address is just that address) that remote servers may be reached at although they are private, such as a fediverse server on your own network; see [Servers on your own network](#servers-on-your-own-network). Link-local, unspecified, multicast and IPv6 transition addresses are never allowed. Defaults to `[]`. |
| `maxInboxBodyBytes` | Number. Largest inbox request body accepted, in bytes. A larger request is refused with `413`. Defaults to `1048576` (1 MiB). |
| `maxResponseBodyBytes` | Number. Largest response accepted from a remote server (an actor, a Note, a WebFinger lookup, a delivery's answer), in bytes. Defaults to `524288` (512 KiB). |
| `outboundFetchLimits` | Object. Limits on the fetches an incoming inbox request may cause; see [Outbound Requests and Limits](#outbound-requests-and-limits). Members: `perHostConcurrency` (fetches from one remote host at once, default `4`), `perHostPerMinute` (fetches from one remote host per minute, default `60`), `globalConcurrency` (fetches at once, board wide, default `32`) and `globalPerMinute` (fetches per minute, board wide, default `600`). A value below `1`, or not a number, uses its default. |

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

## Signatures
Every activity delivered to an inbox must be signed, and ENiGMA½ checks the signature with the key the sender's actor publishes. Two signature schemes are accepted:

* **HTTP Signatures (draft-cavage)**, which nearly every server sends. The signature must cover `(request-target)`, `host` and `date`, and on a POST also `digest`; the `Date` header must be within 5 minutes of the board's clock, and the `Digest` must match the body (SHA-256 or SHA-512).
* **HTTP Message Signatures ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421))**, which Fedify-based servers (Ghost, Hollo) send first and Mastodon sends when a server has refused its first attempt. The signature must cover `@method`; the target, as `@target-uri`, or `@request-target` or `@path`; the host, as `@authority` or `@target-uri`; and on a POST, `content-digest` ([RFC 9530](https://www.rfc-editor.org/rfc/rfc9530)) or `digest`. Every digest it covers must match the body. Its `created` parameter is required and must be within 5 minutes of the board's clock (no `Date` header is needed), an `expires` parameter must not be past, and `keyid` must be the key's URL. RSA (`rsa-v1_5-sha256`, `rsa-pss-sha512`), Ed25519 and ECDSA P-256 keys are accepted, with the algorithm taken from `alg` or, without it, from the key. Only the first signature on a request is checked.

A request with a `Signature-Input` header is checked as RFC 9421 only, and is not tried again as draft-cavage if that fails. The URL an RFC 9421 signature covers is built from your base URL (`overrideUrlPrefix`; without it, `domain` with `https://` and the HTTPS port when HTTPS is enabled, otherwise `http://` and the HTTP port) and the request path, never from the `Host` or `X-Forwarded-*` headers. Behind a reverse proxy, including one that handles TLS or serves the board under a path prefix, it matches the URL the sender posted to, as long as `overrideUrlPrefix` names the public URL. A signature that covers the `host` header (Fedify's does, as draft-cavage signatures do) still needs the proxy to pass `Host` on unchanged.

## Outbound Requests and Limits
ENiGMA½ contacts remote servers to look up actors (including the key that signed an incoming request), to resolve handles with WebFinger, to fetch Notes, and to deliver activities.

### Instance Actor
Many servers answer a fetch only when it is signed: Mastodon with authorized fetch (from Mastodon 5.0, actor documents by default), and GoToSocial. ENiGMA½ therefore signs the fetches it makes for itself (the actor and key that signed an incoming request, a forwarded or boosted Note, a gone actor, the follower and following counts shown on actor screens) as the board's **instance actor**, unless a local user has a reason to sign them: the user whose inbox received an activity, or a local follower of the remote actor. Deliveries and a user's own searches are signed as the user, as before.

The instance actor is an `Application` actor at `/_enig/ap/actor`, with your web domain as its name, so WebFinger finds it as `acct:<domain>@<domain>` (for example `acct:bbs.example.com@bbs.example.com`). It speaks for no one: it cannot be followed, its outbox is empty, and its key signs nothing but these fetches. Its key pair is made at the first start with ActivityPub enabled and kept in `db/activitypub.sqlite3` (table `instance_key`). Until it exists, about a second after that first start, fetches go unsigned as before, and the instance actor and its WebFinger answer `503`. If making or storing it fails, the log says so at `error` and it is tried again a minute later, when the board next needs it.

There is no key rotation. If the row is deleted, a new key is made at the next start, but remote servers that cached the old key do not all notice at once: Mastodon fetches a key again once a signature fails to verify with the one it has, while GoToSocial keeps its cached key until it refreshes the account. Until then those servers refuse the board's signed fetches, as they did unsigned ones. So keep the key, as you keep the rest of `db/activitypub.sqlite3`.

A signed fetch does not follow redirects. When one signed as the instance actor is answered with a redirect, it is made again unsigned, which follows it, as these fetches did before; a server at the redirect's target that requires signed fetches refuses it, as before.

Behind a reverse proxy, nothing new needs forwarding: the instance actor lives under `/_enig/` like every other ActivityPub URL, and its URLs are built from your base URL (`overrideUrlPrefix`, or `domain` and the web server's port), as your users' are. A local user named exactly like your web domain is not found through WebFinger, since that name belongs to the instance actor; ENiGMA½ logs a warning at startup if there is one. `/.well-known/nodeinfo` links the instance actor too ([FEP-2677](https://codeberg.org/fediverse/fep/src/branch/main/fep/2677/fep-2677.md)).

### Address Checks
ENiGMA½ will not connect to a remote server whose name resolves to a loopback, private, link-local (including cloud metadata), shared (CGNAT), multicast, documentation or otherwise reserved address, IPv4 or IPv6. The same applies to the IPv4-mapped and NAT64 forms of those addresses, to addresses given literally in a URL, and to names such as `localhost` or anything under `.local`, `.internal` or `.lan`. Every address a name resolves to is checked, at the moment of connecting, and again for each redirect; at most 3 redirects are followed. A name refused for the address it resolves to is logged as a warning, with the host and the address.

Your board's own address is the exception. Behind a reverse proxy, the board's public name often resolves, on the machine ENiGMA½ runs on, to a private address (split-horizon DNS), and ENiGMA½ fetches its own URLs too: its local users' actors, WebFinger for its own users, deliveries to its own inbox. A URL with exactly the scheme, host name and port of your board's base URL (`overrideUrlPrefix` if set, otherwise built from `domain` and the web server's port) is therefore not checked. The same host name on any other port or scheme is refused outright, so the exception reaches nothing but the board itself. The `http://`/`https://` rules still apply: an `http://` base URL is only fetched with `allowInsecureHttp`. Nothing needs configuring for this, but the board's own address is never taken from the placeholder `domain` a new install ships with.

#### Servers on your own network
A fediverse server on your own network whose name resolves, for ENiGMA½, to a private address is refused like any other. List its address, or a range that holds it, in `allowedPrivateAddresses`:

```hjson
contentServers: {
    web: {
        handlers: {
            activityPub: {
                enabled: true
                //  a GoToSocial box on the LAN, and an IPv6 ULA prefix
                allowedPrivateAddresses: [
                    "192.168.1.20"
                    "fd12:3456:789a::/48"
                ]
            }
        }
    }
}
```

This applies to the addresses a name resolves to and to addresses written in a URL; names such as `localhost` or anything under `.local`, `.internal` or `.lan` are still refused, so use a name that resolves to the address. Link-local addresses (`169.254.0.0/16` and `fe80::/10`, where cloud metadata services live), unspecified (`0.0.0.0/8`, `::`) and multicast addresses, and their IPv4-mapped and NAT64 forms, can never be allowed, nor can IPv6 transition addresses (IPv4-compatible `::/96` other than `::1`, IPv4-translated, 6to4, Teredo and local-use NAT64): an entry that covers them, even `0.0.0.0/0`, leaves them refused. An entry that is not an address or CIDR is ignored with a warning in the log. When a connection is refused for an address that listing would allow, the warning names `allowedPrivateAddresses`.

A refused lookup is remembered for 15 minutes (see [Failed Lookups](#failed-lookups)); saving `config.hjson` forgets every remembered failure, so a change here takes effect at once.

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

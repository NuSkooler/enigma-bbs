---
title: Web Server
description: "The built-in HTTP/HTTPS server that powers download links, password resets and static files."
sidebar:
    order: 1
---
ENiGMA½ comes with a built in *content server* for supporting both HTTP and HTTPS. Currently the [File Base](../../filebase/index.md#web-downloads) registers routes for file downloads, password reset email links are handled via the server, and static files can also be served for your BBS. Other features will likely come in the future or you can easily write your own!

## Configuration

By default the web server is not enabled. To enable it, you will need to at a minimum configure two keys in the `contentServers.web` section of `config.hjson`:

```hjson
contentServers: {
    web: {
        domain: bbs.yourdomain.com

        http: {
            enabled: true
            port: 8080
        }
    }
}
```

The following is a table of all configuration keys available under `contentServers.web`:

| Key | Required | Description |
|------|----------|-------------|
| `domain` | Yes | Sets the domain, e.g. `bbs.yourdomain.com`. |
| `http` | No | Sub configuration for HTTP (non-secure) connections. See **HTTP Configuration** below. |
| `https` | No | Sub configuration for HTTPS (secure) connections. See **HTTPS Configuration** below. |
| `staticRoot` | No | Path serving as the static/public root. Defaults to `enigma-bbs/www`. See **Static Root** below. |
| `overrideUrlPrefix` | No | Instructs the system to be explicit when handing out URLs. Useful if your server is behind a transparent proxy. |
| `wsTerm` | No | The [enig-term](../loginservers/enig-term.md) browser terminal at `/_enig/ws-term/`, served once its files are installed. |

### HTTP Configuration

Entries available under `contentServers.web.http`:

| Key | Required | Description |
|------|----------|-------------|
| `enabled` | Yes | Set to `true` to enable this server. Defaults to `false`. |
| `port` | No | Override the default port of `8080`. |
| `address` | No | Sets an explicit bind address. |

### HTTPS Configuration

Entries available under `contentServers.web.https`:

| Key | Required | Description |
|------|----------|-------------|
| `enabled` | Yes | Set to `true` to enable this server. Defaults to `false`. |
| `port` | No | Override the default port of `8443`. |
| `address` | No | Sets an explicit bind address. |
| `certPem` | No | Overrides the default certificate path of `config/https_cert.pem`. Certificate must be in PEM format. See **Certificates** below. |
| `keyPem` | No | Overrides the default certificate key path of `config/https_cert_key.pem`. Key must be in PEM format. See **Certificates** below. |

#### Certificates

If you don't have a TLS certificate for your domain, a good source for a certificate can be [Let's Encrypt](https://letsencrypt.org/) who supplies free and trusted TLS certificates. A common strategy is to place another web server such as [Caddy](https://caddyserver.com/) in front of ENiGMA½ acting as a transparent proxy and TLS termination point.

:::note
Keep in mind that the SSL certificate provided by Let's Encrypt's Certbot is by default stored in a privileged location; if your ENIGMA instance is not running as root (which it should not be!), you'll need to copy the SSL certificate somewhere else in order for ENIGMA to use it.
:::

## Reverse Proxies
The web server is often run behind a reverse proxy such as nginx or [Caddy](https://caddyserver.com/), which then connects to ENiGMA½ in place of every visitor. To find a visitor's own address, ENiGMA½ reads `X-Forwarded-For` (right to left, skipping addresses that are themselves trusted proxies) or, failing that, `X-Real-IP`, but only on requests from an address in the top-level `trustedProxies` setting. Requests from anywhere else use the connecting address, and their forwarded headers are ignored.

The default covers loopback and the private ranges (`127.0.0.0/8`, `::1/128`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), so a proxy on the same host, in another Docker container or on the LAN needs no change. A proxy on any other address must be listed:

```hjson
trustedProxies: [
    "127.0.0.0/8"
    "::1/128"
    "203.0.113.10"
]
```

Entries are IPv4 or IPv6 addresses or CIDRs. Setting `trustedProxies` replaces the default list, so keep the entries you still need. The same setting applies to the [WebSocket login server](../loginservers/websocket.md#trusted-proxies). The `Forwarded` header (RFC 7239) is not read.

Caddy's `reverse_proxy` sends `X-Forwarded-For` by itself. With nginx, add:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP       $remote_addr;
```

The web server's rate limits (REST API login, password reset and 2FA/OTP registration pages) count requests per visitor address, so behind a trusted proxy each visitor has their own limit, and a `Rate limit exceeded` log line names the visitor rather than the proxy.

## Static Root
Static files live relative to the `contentServers.web.staticRoot` path which defaults to `enigma-bbs/www`. This is also commonly known as your "public root" directory.

## Custom Error Pages
Customized error pages can be created for [HTTP error codes](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes#4xx_Client_Error) by providing a `<error_code>.html` file in the *static routes* area. For example: `404.html`.

## REST API
ENiGMA½ includes a built-in [REST API](./rest-api.md) served under `/_enig/api/v1/`, providing programmatic access to message bases, file areas, user profiles, and system information.

## Web Handlers
[Web Handlers](./web-handlers.md) are loaded by the web content server and provide a easy way for adding additional routes & functionality to ENiGMA.
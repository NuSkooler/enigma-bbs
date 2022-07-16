---
layout: page
title: Web Server
---
ENiGMA½ comes with a built in *content server* for supporting both HTTP and HTTPS. Currently the [File Bases](../modding/file-base-web-download-manager.md) registers routes for file downloads, password reset email links are handled via the server, and static files can also be served for your BBS. Other features will likely come in the future or you can easily write your own!

# Configuration

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
| `domain` | :+1: | Sets the domain, e.g. `bbs.yourdomain.com`. |
| `http` | :-1: | Sub configuration for HTTP (non-secure) connections. See **HTTP Configuration** below. |
| `overrideUrlPrefix` | :-1: | Instructs the system to be explicit when handing out URLs. Useful if your server is behind a transparent proxy. |

### HTTP Configuration

Entries available under `contentServers.web.http`:

| Key | Required | Description |
|------|----------|-------------|
| `enable` | :+1: | Set to `true` to enable this server.
| `port` | :-1: | Override the default port of `8080`. |
| `address` | :-1: | Sets an explicit bind address. |

### HTTPS Configuration

Entries available under `contentServers.web.https`:

| Key | Required | Description |
|------|----------|-------------|
| `enable` | :+1: | Set to `true` to enable this server.
| `port` | :-1: | Override the default port of `8080`. |
| `address` | :-1: | Sets an explicit bind address. |
| `certPem` | :+1: | Overrides the default certificate path of `/config/https_cert.pem`. Certificate must be in PEM format. See **Certificates** below. |
| `keyPem` | :+1: | Overrides the default certificate key path of `/config/https_cert_key.pem`. Key must be in PEM format. See **Certificates** below. |

#### Certificates

If you don't have a TLS certificate for your domain, a good source for a certificate can be [Let's Encrypt](https://letsencrypt.org/) who supplies free and trusted TLS certificates. A common strategy is to place another web server such as [Caddy](https://caddyserver.com/) in front of ENiGMA½ acting as a transparent proxy and TLS termination point.

> :information_source: Keep in mind that the SSL certificate provided by Let's Encrypt's Certbot is by default stored in a privileged location; if your ENIGMA instance is not running as root (which it should not be!), you'll need to copy the SSL certificate somewhere else in order for ENIGMA to use it.

## Static Routes

Static files live relative to the `contentServers.web.staticRoot` path which defaults to `enigma-bbs/www`.

`index.html, favicon.ico`, and any error pages like `404.html` are accessible from the route path. Other static assets hosted by the web server must be referenced from `/static/`, for example:

```html
<a href="/static/about.html"> Example Link
```

## Custom Error Pages

Customized error pages can be created for [HTTP error codes](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes#4xx_Client_Error) by providing a `<error_code>.html` file in the *static routes* area. For example: `404.html`.

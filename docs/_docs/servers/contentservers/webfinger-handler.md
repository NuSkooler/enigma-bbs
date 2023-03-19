---
layout: page
title: WebFinger Web Handler
---
The WebFinger ([webfinger.js](/core/servers/content/web_handlers/webfinger.js)) [Handler](./web-handlers.md) provides basic [WebFinger](https://webfinger.net/) ([RFC7033](https://www.rfc-editor.org/rfc/rfc7033)) support, enabling servers such as those participating in the [Mastodon](https://en.wikipedia.org/wiki/Mastodon_(social_network)) [Fediverse](https://en.wikipedia.org/wiki/Fediverse) to discover basic information about a user.

# Supported Features
* [profile-page](https://webfinger.net/rel/profile-page/)
* [ActivityStream URI](https://www.w3.org/TR/activitystreams-core/) via rel of `self` and of type `application/activity+json`
* Subscription URI template via rel of `http://ostatus.org/schema/1.0/subscribe`

# Configuration
By default, the WebFinger handler is not enabled. To enable, at a minimum set `contentServers.web.handlers.webFinger.enabled` to `true` in `config.hjson`:

```js
contentServers: {
    web: {
        handlers: {
            webFinger: {
                enabled: true // wow, much nest!
            }
        }
    }
}
```

## Configuration Keys
| Key | Description |
| ----|-------------|
| `enabled` | Boolean. Set to `true` to enable WebFinger services |
| `profileTemplate` | String. Provide a fully qualified, or relative to [static root](./web-server.md#static-root) path to a template file for fetching profile information. See [Profile Template](#profile-template) for more information.

## Profile Template
A profile template file can offer flexibility as to what information, the format, and MIME type served by the [profile-page](https://webfinger.net/rel/profile-page/) WebFinger query. Set the `profileTemplate` key in your `webFinger` configuration block to a path to serve as the template. The MIME type will be determined by the file's extension:

```js
contentServers: {
    web: {
        handlers: {
            webFinger: {
                enabled: true
                profileTemplate: './wf/fancy-profile.html'
            }
        }
    }
}
```

> :information_source: A sample template can be found at `www/wf/profile.template.html`

# Example Session
```shell
# WebFinger query
> http get 'https://xibalba.l33t.codes/.well-known/webfinger?resource=acct:NuSkooler@xibalba.l33t.codes'
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 558
Content-Type: application/jrd+json
Date: Mon, 02 Jan 2023 03:36:20 GMT
Keep-Alive: timeout=5

{
    "aliases": [
        "https://xibalba.l33t.codes/_enig/wf/@NuSkooler",
        "https://xibalba.l33t.codes/_enig/ap/users/NuSkooler"
    ],
    "links": [
        {
            "href": "https://xibalba.l33t.codes/_enig/wf/@NuSkooler",
            "rel": "https://webfinger.net/rel/profile-page",
            "type": "text/plain"
        },
        {
            "href": "https://xibalba.l33t.codes/_enig/ap/users/NuSkooler",
            "rel": "self",
            "type": "application/activity+json"
        },
        {
            "rel": "http://ostatus.org/schema/1.0/subscribe",
            "template": "http://xibalba.l33t.codes/_enig/ap/authorize_interaction?uri={uri}"
        }
    ],
    "subject": "acct:NuSkooler@xibalba.l33t.codes"
}
```

```shell
# Now we can fetch the profile
> http get 'https://xibalba.l33t.codes/_enig/wf/@NuSkooler'
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 116
Content-Type: text/plain
Date: Mon, 02 Jan 2023 03:41:19 GMT
Keep-Alive: timeout=5

User information for: NuSkooler

Real Name: Bryan Ashby
Login Count: 432
Affiliations: ENiG
Achievement Points: 405
```
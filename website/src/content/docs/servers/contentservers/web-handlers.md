---
title: Web Handlers
description: "Add your own routes to the web server, and the handlers that ship with ENiGMA½."
sidebar:
    order: 2
---
Web handlers provide a way to easily add additional _routes_ to your [Web Server](./web-server.md).

## Built in Web Handler Modules
* [WebFinger](./webfinger-handler.md): Provides basic [WebFinger](https://webfinger.net/) ([RFC7033](https://www.rfc-editor.org/rfc/rfc7033)) support.
* System General: Serves user avatars.
* NodeInfo2: Handles [NodeInfo2](https://github.com/jaywink/nodeinfo2) requests (`/.well-known/x-nodeinfo2`), and serves [NodeInfo](https://nodeinfo.diaspora.software/) 2.0 and 2.1 (found through `/.well-known/nodeinfo`). The `activeHalfyear`, `activeMonth` and (NodeInfo2 only) `activeWeek` counts under `usage.users` are the distinct users whose last login was within 180, 30 and 7 days, never more than the total, which is the live number of users (inactive or disabled users count, as they do in the total). Usage counts are cached for 10 minutes.
* ActivityPub:

### Building Your Own

:::caution
Custom web handlers are an **advanced, internal extension point**. By default the system loads handlers from `core/servers/content/web_handlers/` — the same directory as the built-in handlers. You can override the search path via `paths.webHandlers` in `config.hjson` if you want to keep custom code out of the ENiGMA source tree.
:::

#### Skeleton

Inherit from `WebHandlerModule`, export `moduleInfo` and `getModule`, then register your route(s) inside `init()`:

```javascript
// mods/web_handlers/my_handler.js
const WebHandlerModule = require('../../core/web_handler_module');

exports.moduleInfo = {
    name: 'My Handler',
    desc: 'Does something custom',
    author: 'You',
    packageName: 'com.example.my-handler',
};

exports.getModule = class MyWebHandler extends WebHandlerModule {
    constructor() {
        super();
    }

    init(webServer, cb) {
        super.init(webServer, err => {
            if (err) { return cb(err); }

            this.webServer.addRoute({
                method: 'GET',
                path:   /^\/my-path\/?$/,
                handler: this._handleRequest.bind(this),
            });

            return cb(null);
        });
    }

    _handleRequest(req, resp) {
        const body = JSON.stringify({ hello: 'world' });
        resp.writeHead(200, {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        resp.end(body);
    }
};
```

#### Enabling Your Handler

Add an entry under `contentServers.web.handlers` in `config.hjson`. The key is the **camelCase** form of your `moduleInfo.name`:

```hjson
contentServers: {
    web: {
        handlers: {
            myHandler: {
                enabled: true
            }
        }
    }
}
```

Restart ENiGMA and your route will be registered alongside the built-in handlers.
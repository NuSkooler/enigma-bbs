---
layout: page
title: ActivityPub Web Handler
---
The ActivityPub ([activitypub.js](/core/servers/content/web_handlers/activitypub.js)) provides [ActivityPub](https://www.w3.org/TR/activitypub/) support currently compatible with [Mastodon](https://joinmastodon.org/) and perhaps similar ActivityPub systems within the [Fediverse](https://en.wikipedia.org/wiki/Fediverse) allowing direct and public messaging, following/followers, etc. to be integrated with the ENiGMA½ BBS system.

# Supported Features
* ActivityPub with Mastodon support
* Users are generated a random avatar once enabled with the ability to change them within their ActivityPub configuration
* Social Manager
* Actor search (that is, other users within the Fediverse)
* Private and public messaging to/from the Fediverse

# Configuration
## Enabling ActivityPub
Full ActivityPub support requires the [Web Server](./web-server.md) module be enabled as well as a number of Web Handlers. Each handler configured within the `contentServers.web.handlers` block keys below of your `config.hjson` must be set to `enabled: true`:

| Handler | Key | Description | Default |
|---------|-----|-------------|---------|
| [WebFinger](./webfinger-handler.md) | `webFinger` | Allows other servers to discover your user/Actors | disabled |
| System General | `systemGeneral` | Serves avatar images | enabled |
| NodeInfo2 | `nodeInfo2` | Allows other systems to query information about your node | enabled |
| ActivityPub | `activityPub` | Described within this file | disabled |

**Example**
```js
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

## Configuration Keys
| Key | Description |
| ----|-------------|
| `enabled` | Boolean. Set to `true` to enable WebFinger services |
| `selfTemplate` | String. Provide a fully qualified, or relative to [static root](./web-server.md#static-root) path to a template file for fetching profile information. Defaults to the same file used for [WebFinger](./webfinger-handler.md) queries; See [WebFinger](./webfinger-handler.md#profile-template) for more information.

## Configuring Defaults
### General
General ActivityPub configuration can be found within the `activityPub` block:

| Key | Description | Default |
| ----|-------------|---------|
| `autoSignatures` | Include auto-signatures in ActivityPub outgoing message/Notes? | `false` |
| `maxMessageLength` | Max single message/Note length in characters. Note that longer lengths *are* generally allowed by remote systems. | `500` |

### Default User Settings
Settings applied to new users or users first enabling ActivityPub are found within `users.activityPub` with the following members:

| Key | Description | Default |
| ----|-------------|---------|
| `enabled` | Enabled for users by default? | `false` |
| `manuallyApproveFollowers` | Do users need to manually approve followers? | `false` |
| `hideSocialGraph` | Hide users social graph? (followers, following, ...) | `false` |
| `showRealName` | Show real name? | `true` |



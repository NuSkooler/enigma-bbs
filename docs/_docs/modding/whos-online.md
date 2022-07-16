---
layout: page
title: Who's Online
---
## The Who's Online Module
The built in `whos_online` module provides a basic who's online mod.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`):
* `userId`: User ID.
* `authenticated`: boolean if the client has a logged in user or not.
* `userName`: Login username.
* `node`: Node ID the user is connected to.
* `timeOn`: A human friendly amount of time the user has been online.
* `realName`: User's real name.
* `location`: User's location.
* `affiliation` or `affils`: Users affiliations.
* `action`: Current action/view in the system taken from the `desc` field of the current MenuModule they are interacting with. For example, "Playing L.O.R.D".
* `isSecure`: Is the client securely connected?
* `serverName`: Name of connected server such as "Telnet" or "SSH".

> :information_source: These properties are available via the `client_connections.js` `getActiveConnectionList()` API.

